import { locale, tr } from './language.js';

const timeOptions = { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' };
const dateOptions = { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' };
const formatters = new Map();
function format(value, options) {
  const language = locale();
  if (!formatters.has(language)) {
    formatters.set(language, new Map([timeOptions, dateOptions].map(option => [option, new Intl.DateTimeFormat(language, option)])));
  }
  return formatters.get(language).get(options).format(value);
}
export const time = value => format(value, timeOptions);
export const date = value => format(value, dateOptions);
export const dayTime = value => date(value) + ' · ' + time(value);
export const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const label = value => safe(tr(value));
export const empty = message => '<p>' + safe(message) + '</p>';
export const button = (action, id, label, kind = 'quiet') => '<button class="' + kind + '" data-action="' + action + '" data-id="' + safe(id) + '">' + safe(tr(label)) + '</button>';
export const row = (name, detail, actions = '') => '<div class="row"><div><strong>' + safe(name) + '</strong><p>' + safe(detail) + '</p></div><div class="actions">' + actions + '</div></div>';
export const controls = (entity, item) => button('edit-' + entity, item.id, 'Edit') + button('delete-' + entity, item.id, entity === 'medications' ? 'Retire' : 'Remove');
