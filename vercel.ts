const rawOrigin = process.env.RENDER_API_ORIGIN?.trim();
const backend = rawOrigin ? new URL(rawOrigin) : null;
if (backend && (backend.protocol !== 'https:' || backend.pathname !== '/' || backend.search || backend.hash || backend.username || backend.password)) {
  throw new Error('Set RENDER_API_ORIGIN to the Render service HTTPS origin, without a path.');
}

export const config = {
  framework: null,
  installCommand: '',
  buildCommand: '',
  outputDirectory: 'public',
  rewrites: backend ? [{ source: '/api/:path*', destination: backend.origin + '/api/:path*' }] : [],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Frame-Options', value: 'DENY' }
      ]
    },
    {
      source: '/api/:path*',
      headers: [{ key: 'Cache-Control', value: 'no-store' }]
    }
  ]
};
