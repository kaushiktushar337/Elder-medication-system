const byId = id => document.getElementById(id);
const timeOptions = { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' };
const time = value => new Intl.DateTimeFormat('en-IN', timeOptions).format(value);
const date = value => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(value);
const dayTime = value => date(value) + ' · ' + time(value);
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const empty = message => '<p>' + safe(message) + '</p>';
const button = (action, id, label, kind = 'quiet') => '<button class="' + kind + '" data-action="' + action + '" data-id="' + safe(id) + '">' + label + '</button>';
const row = (name, detail, actions = '') => '<div class="row"><div><strong>' + safe(name) + '</strong><p>' + safe(detail) + '</p></div><div class="actions">' + actions + '</div></div>';
let state;
let activeView = 'today';
let syncedAt = 0;
let refreshQueue = Promise.resolve();
let audio;
let armed = false;
const sounded = new Set();
const latestMarkup = new Map();

function show(id, markup) {
  const element = byId(id);
  if (latestMarkup.get(id) === markup) return;
  const focused = document.activeElement;
  const action = element.contains(focused) && focused.dataset.action;
  element.innerHTML = markup;
  latestMarkup.set(id, markup);
  if (action) [...element.querySelectorAll('button')].find(item => item.dataset.action === action && item.dataset.id === focused.dataset.id)?.focus();
}

function notice(message = '', error = false) {
  const element = byId('notice');
  element.textContent = message;
  element.toggleAttribute('data-error', error);
}

async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, {
    method,
    ...(method !== 'GET' && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The care service may still be waking up. Try again in a moment.');
  }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') auth();
    throw new Error(result.error || 'Request failed.');
  }
  return result;
}

function auth() {
  state = undefined;
  armed = false;
  sounded.clear();
  byId('sound').textContent = 'Enable sound';
  byId('sound').setAttribute('aria-pressed', 'false');
  byId('auth').hidden = false;
  byId('dashboard').hidden = true;
  byId('navigation').hidden = true;
  byId('logout').hidden = true;
  byId('passcode-dialog').close();
  for (const id of Object.keys(forms)) cancelEdit(byId(id));
}

function setView(view) {
  activeView = view;
  for (const element of document.querySelectorAll('.view')) element.hidden = element.id !== view;
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

function refresh() {
  const request = refreshQueue.then(async () => {
    state = await api('state');
    syncedAt = Date.now();
    byId('auth').hidden = true;
    byId('dashboard').hidden = false;
    byId('navigation').hidden = false;
    byId('logout').hidden = false;
    setView(activeView);
    render();
  });
  refreshQueue = request.catch(() => {});
  return request;
}

const now = () => state.now + Date.now() - syncedAt;
const grace = dose => dose.demo ? state.demoGrace : 30 * 60_000;
const status = dose => dose.taken_at ? 'Taken' : now() >= dose.due + grace(dose) ? 'Unconfirmed' : now() >= dose.due ? 'Due' : 'Upcoming';
const pill = label => '<span class="pill" data-status="' + safe(label) + '">' + safe(label) + '</span>';
const doseDetail = dose => dose.amount + ' · ' + time(dose.due);

function followupRow(item, checkin = false) {
  const name = checkin ? 'Check-in requested' : item.name;
  let detail = checkin ? dayTime(item.requested_at) : 'Dose unconfirmed · ' + dayTime(item.due);
  if (item.claimed_by) {
    detail = item.completed_at
      ? 'Caller: ' + item.claimed_by + ' · Completed ' + dayTime(item.completed_at)
      : 'Following up: ' + item.claimed_by + ' · ' + time(item.claimed_at);
  }
  const prefix = checkin ? 'checkin-' : '';
  const canComplete = state.me.owner || item.claimed_member === state.me.id;
  const action = item.completed_at ? pill('Checked in')
    : item.claimed_at ? pill('Claimed') + (canComplete ? button(prefix + 'complete', item.id, 'Mark check-in complete') : '')
      : button(prefix + 'claim', item.id, 'I’ll call', 'primary');
  return row(name, detail, action);
}

function renderReport(current) {
  const lastWeek = state.start - 6 * 86_400_000;
  const recorded = state.doses.filter(dose => !dose.demo && dose.due >= lastWeek &&
    (dose.taken_at || status(dose) === 'Unconfirmed'));
  const confirmed = recorded.filter(dose => dose.taken_at).length;
  const appointment = state.appointments.find(item => item.due > current);
  show('report-content', '<h2>' + safe(state.person.name) + '</h2>'
    + empty(date(lastWeek) + ' through ' + date(current))
    + empty(confirmed + ' confirmed · ' + (recorded.length - confirmed) + ' unconfirmed')
    + (appointment ? empty('Next appointment: ' + appointment.name + ' · ' + dayTime(appointment.due)) : '')
    + (recorded.length ? recorded.map(dose => row(dose.name, dayTime(dose.due), pill(status(dose)))).join('')
      : empty('No confirmed or unconfirmed dose records in this period.')));
}

function renderToday() {
  const current = now();
  const today = state.doses.filter(dose => dose.due >= state.start && (dose.due < state.start + 86_400_000 || dose.demo));
  const due = today.filter(dose => !dose.taken_at && dose.due <= current && current < dose.due + grace(dose));
  const next = due[0] ?? today.find(dose => !dose.taken_at && dose.due > current);
  const appointment = state.appointments.find(item => item.due > current);
  const followups = state.doses.filter(dose => (!dose.taken_at && status(dose) === 'Unconfirmed') || dose.claimed_at).slice(-12).reverse();
  const taken = today.filter(dose => dose.taken_at).length;
  byId('dose-progress').hidden = today.length === 0;
  byId('dose-count').textContent = taken + ' of ' + today.length + ' taken';
  byId('dose-meter').max = today.length || 1;
  byId('dose-meter').value = taken;
  byId('date').textContent = date(current);
  byId('welcome').textContent = 'Today for ' + state.person.name;
  byId('next-heading').textContent = due.length ? 'Dose due now' : 'Next dose';
  show('next-dose', next
    ? '<p class="dose-time">' + safe(time(next.due)) + '</p><p class="metric">' + safe(next.name) + '</p>' + empty(next.amount)
      + (due.length ? button('taken', next.id, 'Mark taken', 'primary hero-action') : '')
    : '<p class="metric">' + (today.length > 0 && taken === today.length ? 'All doses recorded' : 'No upcoming doses today') + '</p>');
  show('next-appointment', appointment
    ? '<p class="appointment-date">' + safe(dayTime(appointment.due)) + '</p><p class="metric">' + safe(appointment.name) + '</p>' + (appointment.location ? empty(appointment.location) : '')
    : empty('No upcoming appointments.'));
  show('today-doses', today.map(dose => row(dose.name, doseDetail(dose), pill(status(dose)) + (!dose.taken_at && dose.due <= current && dose !== due[0] ? button('taken', dose.id, 'Mark taken', 'primary') : ''))).join('') || empty('Add a medication in Schedule.'));
  byId('request-checkin').hidden = !state.me.owner || state.checkins.some(item => !item.completed_at);
  show('followups', [...state.checkins.map(item => followupRow(item, true)), ...followups.map(dose => followupRow(dose))].join('') || empty('No follow-ups to show.'));
  show('history-list', state.doses.filter(dose => dose.due <= now()).slice(-30).reverse().map(dose => row(dose.name, dayTime(dose.due) + (dose.taken_by ? ' · Recorded by ' + dose.taken_by : ''), pill(status(dose)) + (!today.includes(dose) && !dose.taken_at ? button('taken', dose.id, 'Mark taken') : ''))).join('') || empty('No dose history yet.'));
  renderReport(current);
  const alarm = byId('alarm');
  const alarmText = due.length ? 'Dose due: ' + due.map(dose => dose.name).join(', ') : '';
  if (alarm.textContent !== alarmText) alarm.textContent = alarmText;
  alarm.hidden = !due.length;
  if (armed && audio?.state === 'running' && due.some(dose => !sounded.has(dose.id))) {
    due.forEach(dose => sounded.add(dose.id));
    tone();
  }
}

const controls = (entity, item) => button('edit-' + entity, item.id, 'Edit') + button('delete-' + entity, item.id, entity === 'medications' ? 'Retire' : 'Remove');
const deliveryLabels = { accepted: 'Accepted by Brevo', sending: 'Sending', failed: 'Failed', retry: 'Retry pending', review: 'Check Brevo logs', unconfigured: 'Provider not configured', suppressed: 'Suppressed' };
const reminderLabels = { upcoming: 'Upcoming dose', unconfirmed: 'Unconfirmed dose', appointment: 'Appointment', checkin: 'Requested check-in' };

function render() {
  renderToday();
  byId('demo-panel').hidden = !(state.me.owner && state.demoEnabled);
  byId('demo-grace').textContent = state.demoGrace / 60_000 + (state.demoGrace === 60_000 ? ' minute' : ' minutes');
  byId('circle-owner').hidden = !state.me.owner;
  byId('circle-helper').hidden = state.me.owner;
  show('medication-list', state.medications.map(item => row(item.name, item.amount + ' · ' + item.time + ' IST', controls('medications', item))).join('') || empty('No medications yet.'));
  show('appointment-list', state.appointments.map(item => row(item.name, dayTime(item.due) + (item.location ? ' · ' + item.location : ''), controls('appointments', item))).join('') || empty('No appointments yet.'));
  show('contact-list', state.contacts.map(item => row(item.name, [item.email, item.phone, item.member ? (item.revoked ? 'Invite revoked' : 'Profile access') : 'Alerts only', item.alerts ? 'Alerts on' : 'Alerts off'].filter(Boolean).join(' · '), controls('contacts', item) + (item.member && !item.revoked ? button('revoke', item.id, 'Revoke access') : ''))).join('') || empty('Add a family member or caregiver.'));
  show('delivery-list', state.deliveries.map(item => row(reminderLabels[item.kind], item.recipient + ' · ' + time(item.attempted), pill(deliveryLabels[item.state] || item.state))).join('') || empty('No reminders sent yet.'));
}

function tone() {
  const start = audio.currentTime;
  for (const [index, frequency] of [523, 659, 784, 659, 784].entries()) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const at = start + index * .24;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(.17, at + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, at + .21);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + .22);
  }
}

byId('sound').addEventListener('click', async () => {
  if (armed) {
    armed = false;
  } else {
    try {
      audio ??= new AudioContext();
      await audio.resume();
      tone();
      armed = true;
      notice('Sound enabled for this open page.');
    } catch { notice('Sound is unavailable. On-screen alerts are active.', true); }
  }
  byId('sound').setAttribute('aria-pressed', String(armed));
  byId('sound').textContent = armed ? 'Sound on' : 'Enable sound';
});

function passcode(value, context) {
  byId('passcode-value').value = value.match(/.{1,8}/g).join('-');
  byId('passcode-context').textContent = context;
  byId('passcode-dialog').showModal();
}
byId('passcode-dialog').addEventListener('close', () => { byId('passcode-value').value = ''; });
byId('copy-code').addEventListener('click', async () => {
  const input = byId('passcode-value');
  try {
    await navigator.clipboard.writeText(input.value);
    byId('copy-code').textContent = 'Copied';
  } catch { input.select(); }
});
byId('passcode-dialog').addEventListener('close', () => { byId('copy-code').textContent = 'Copy passcode'; });

const forms = {
  'medication-form': ['medications', 'medication'],
  'appointment-form': ['appointments', 'appointment'],
  'contact-form': ['contacts', 'contact']
};
const formValues = form => Object.fromEntries(new FormData(form));
function cancelEdit(form) {
  form.reset();
  delete form.dataset.edit;
  form.querySelector('button.primary').textContent = 'Add ' + forms[form.id][1];
  form.querySelector('.cancel').hidden = true;
  if (form.id === 'contact-form') byId('invite-label').hidden = false;
}

async function perform(control, action) {
  control.disabled = true;
  notice();
  try { await action(); }
  catch (error) { notice(error.message, true); }
  finally { control.disabled = false; }
}

for (const [id, [entity]] of Object.entries(forms)) {
  const form = byId(id);
  form.querySelector('.cancel').addEventListener('click', () => cancelEdit(form));
  form.addEventListener('submit', event => {
    event.preventDefault();
    perform(form.querySelector('.primary'), async () => {
      const values = formValues(form);
      const edit = form.dataset.edit;
      if (entity === 'appointments') values.due = Date.parse(values.due + '+05:30');
      if (entity === 'contacts') {
        values.alerts = form.elements.alerts.checked;
        values.invite = !edit && form.elements.invite.checked;
      }
      const result = await api(entity + (edit ? '/' + edit : ''), edit ? 'PATCH' : 'POST', values);
      cancelEdit(form);
      await refresh();
      if (result.passcode) passcode(result.passcode, 'Share this privately with ' + values.name + '. It is shown once.');
      else notice(edit ? 'Changes saved.' : 'Added successfully.');
    });
  });
}

for (const [id, path] of [['login-form', 'login'], ['profile-form', 'profiles']]) {
  const form = byId(id);
  form.addEventListener('submit', event => {
    event.preventDefault();
    perform(form.querySelector('.primary'), async () => {
      const result = await api(path, 'POST', formValues(form));
      form.reset();
      activeView = 'today';
      await refresh();
      if (result.passcode) passcode(result.passcode, 'Keep this privately. You’ll need it to return to this profile on another device.');
    });
  });
}

byId('logout').addEventListener('click', event => perform(event.currentTarget, async () => {
  await api('logout', 'POST');
  auth();
}));
byId('add-demo').addEventListener('click', event => perform(event.currentTarget, async () => {
  const demo = await api('demo', 'POST');
  await refresh();
  notice('Demo dose scheduled for ' + time(demo.due) + ' IST.');
}));

document.addEventListener('click', event => {
  const control = event.target.closest('button');
  if (!control || !state) return;
  if (control.dataset.view) {
    notice();
    setView(control.dataset.view);
  }
  const { action, id } = control.dataset;
  if (!action) return;
  if (action.startsWith('edit-')) {
    const entity = action.slice(5);
    const [formId] = Object.entries(forms).find(([, [key]]) => key === entity);
    const form = byId(formId);
    const item = state[entity].find(entry => entry.id === id);
    cancelEdit(form);
    form.dataset.edit = id;
    for (const input of form.querySelectorAll('input')) {
      if (input.name === 'due') input.value = new Date(item.due + 330 * 60_000).toISOString().slice(0, 16);
      else if (input.name === 'alerts') input.checked = Boolean(item.alerts);
      else if (Object.hasOwn(item, input.name)) input.value = item[input.name];
    }
    if (entity === 'contacts') byId('invite-label').hidden = true;
    form.querySelector('.cancel').hidden = false;
    form.querySelector('.primary').textContent = 'Save changes';
    form.elements.name.focus();
    return;
  }
  perform(control, async () => {
    if (action.startsWith('delete-')) {
      const entity = action.slice(7);
      if (!window.confirm(entity === 'medications' ? 'Retire this medication schedule?' : 'Remove this entry?')) return;
      await api(entity + '/' + id, 'DELETE');
      const [formId] = Object.entries(forms).find(([, [key]]) => key === entity);
      if (byId(formId).dataset.edit === id) cancelEdit(byId(formId));
    } else if (action === 'revoke') {
      if (!window.confirm('Revoke this person’s profile access?')) return;
      await api('contacts/' + id + '/revoke', 'POST');
    } else if (action === 'request-checkin') {
      await api('checkins', 'POST');
    } else if (action.startsWith('checkin-')) {
      await api('checkins/' + id + '/' + action.slice(8), 'POST');
    } else {
      await api('doses/' + id + '/' + action, 'POST');
    }
    await refresh();
    const messages = {
      taken: 'Dose recorded.',
      claim: 'You’re now following up.',
      'checkin-claim': 'You’re now following up.',
      complete: 'Check-in marked complete.',
      'checkin-complete': 'Check-in marked complete.',
      'request-checkin': 'Check-in requested.',
      revoke: 'Access revoked.'
    };
    notice(messages[action] || 'Entry removed.');
  });
});

const sync = () => refresh().catch(error => { if (state) notice(error.message, true); });
byId('print-report').addEventListener('click', () => window.print());
setInterval(() => { if (state && !document.hidden) renderToday(); }, 1000);
setInterval(() => { if (state && !document.hidden) sync(); }, 8000);
document.addEventListener('visibilitychange', () => { if (state && !document.hidden) sync(); });
refresh().catch(error => {
  if (byId('auth').hidden) {
    auth();
    notice(error.message, true);
  }
});
