import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import worker, { remind } from '../src/worker.ts';
import { database } from './database.mjs';

const hosted = process.env.RENDER === 'true';
const port = Number(process.env.PORT || 3000);
const path = process.env.DATABASE_PATH || '.local/carecircle.sqlite';
const appUrl = process.env.APP_URL?.replace(/\/$/, '');
const backendUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + port;
if (hosted && (!process.env.PROFILE_SETUP_KEY || !process.env.DATABASE_URL || !appUrl)) {
  throw new Error('Set PROFILE_SETUP_KEY, DATABASE_URL, and APP_URL before starting on Render.');
}
let DB;
if (process.env.DATABASE_URL) {
  const { postgres } = await import('./postgres.mjs');
  try {
    DB = await postgres(process.env.DATABASE_URL, process.env.SUPABASE_DB_CA, process.env.SUPABASE_TLS_MODE);
  } catch (error) {
    console.error('Supabase connection or migration failed', error.code || error.name);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(path), { recursive: true });
  DB = database(path);
}
const env = {
  ...process.env,
  APP_URL: appUrl || (!hosted ? backendUrl : undefined),
  DB
};
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
};
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY'
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const base = hosted ? backendUrl : 'http://' + incoming.headers.host;
    const url = new URL(incoming.url, base);
    if (url.pathname === '/healthz') {
      await env.DB.prepare('SELECT 1').bind().first();
      outgoing.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ok');
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      const asset = Object.hasOwn(assets, url.pathname) && assets[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(incoming.method)) return outgoing.writeHead(404).end();
      const [filename, type] = asset;
      outgoing.writeHead(200, { ...securityHeaders, 'content-type': type });
      outgoing.end(incoming.method === 'HEAD' ? undefined : await readFile(new URL('../public/' + filename, import.meta.url)));
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 8192) {
        outgoing.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Request too large' }));
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.concat(chunks)
    });
    // Use the proxy-facing peer for an additional backstop when forwarding headers are absent.
    const clientAddress = incoming.headers['x-forwarded-for']?.split(',').at(-1)?.trim() || incoming.socket.remoteAddress;
    const response = await worker.fetch(request, { ...env, clientAddress });
    outgoing.writeHead(response.status, { ...securityHeaders, ...Object.fromEntries(response.headers) });
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Request failed', error.name);
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'Request failed' }));
  }
});

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await remind(env); }
  catch (error) { console.error('Reminder check failed', error.name); }
  finally { running = false; }
}

server.listen(port, hosted ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('CareCircle listening on port ' + port);
  void tick();
  setInterval(tick, 60_000).unref();
});
