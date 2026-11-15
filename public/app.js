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
let activePatient = '';
let careTeam = false;
let activeView = 'today';
let syncedAt = 0;
let refreshQueue = Promise.resolve();
let audio;
let armed = false;
let speech;
let alarmTimer;
let alarmEnd;
let alarmGain;
let reviewedInvite = '';
let emailInviteKey = '';
function readInviteFromLocation() {
  const key = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (!key) return;
  emailInviteKey = key;
  history.replaceState(null, '', location.pathname + location.search);
  if (careTeam && !byId('join-panel').hidden) openEmailInvite();
}
function openEmailInvite() {
  if (!emailInviteKey) return;
  resetInviteReview();
  byId('join-panel').open = true;
  byId('join-form').elements.key.value = emailInviteKey;
  emailInviteKey = '';
}
readInviteFromLocation();
window.addEventListener('hashchange', readInviteFromLocation);
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
  const accountRoutes = ['login', 'legacy-login', 'set-login', 'logout', 'profiles', 'accounts', 'patients', 'join'];
  const suffix = accountRoutes.includes(path) ? '' : '?patient=' + encodeURIComponent(activePatient);
  const response = await fetch('/api/' + path + suffix, {
    method,
    ...(method !== 'GET' && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The care service may still be waking up. Try again in a moment.');
  }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['login', 'legacy-login'].includes(path)) auth();
    throw new Error(result.error || 'Request failed.');
  }
  return result;
}

function auth() {
  stopReading();
  stopAlarm();
  byId('join-form').reset();
  resetInviteReview();
  state = undefined;
  activePatient = '';
  careTeam = false;
  byId('patient-access').hidden = true;
  byId('no-patients').hidden = true;
  byId('login-setup').hidden = true;
  armed = false;
  sounded.clear();
  byId('sound').textContent = 'Enable alarm sound';
  byId('sound').setAttribute('aria-pressed', 'false');
  byId('auth').hidden = false;
  byId('dashboard').hidden = true;
  byId('navigation').hidden = true;
  byId('logout').hidden = true;
  byId('passcode-dialog').close();
  for (const id of Object.keys(forms)) cancelEdit(byId(id));
}

function setView(view) {
  if (view !== 'today') stopReading();
  activeView = view;
  for (const element of document.querySelectorAll('.view')) element.hidden = element.id !== view;
  for (const item of document.querySelectorAll('#navigation [data-view]')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

function refresh() {
  const request = refreshQueue.then(async () => {
    const { patients, account } = await api('patients');
    careTeam = account.kind === 'care-team';
    byId('access-nav').textContent = careTeam ? 'Care Circle' : 'People & access';
    byId('access-heading').textContent = careTeam ? 'Care Circle' : 'People & access';
    byId('auth').hidden = true;
    byId('logout').hidden = false;
    byId('patient-access').hidden = !careTeam || account.needsSetup;
    byId('login-setup').hidden = !account.needsSetup;
    byId('no-patients').hidden = !careTeam || account.needsSetup || patients.length > 0;
    byId('join-panel').hidden = !careTeam || account.needsSetup;
    if (careTeam && !account.needsSetup) openEmailInvite();
    if (account.needsSetup) {
      selectPatient('');
      return;
    }
    if (!patients.some(item => item.id === activePatient)) selectPatient(careTeam ? '' : patients[0]?.id || '');
    const selected = activePatient;
    show('patient-cards', patients.map(item => {
      const labels = [item.relationship];
      if (item.overdue) labels.push(item.overdue + ' overdue');
      if (item.pending) labels.push(item.pending + ' appointment ' + (item.pending === 1 ? 'request' : 'requests'));
      return '<button class="patient-card" data-patient="' + safe(item.id) + '" aria-pressed="' + (selected === item.id) + '" data-priority="' + (item.overdue ? 'overdue' : item.pending ? 'pending' : 'normal') + '"><strong>' + safe(item.name) + '</strong><span>' + safe(labels.filter(Boolean).join(' · ')) + '</span></button>';
    }).join(''));
    byId('patient-heading').textContent = 'Care team · ' + account.name;
    byId('patient-avatar').textContent = Array.from(account.name)[0]?.toUpperCase() || '•';
    if (!selected) {
      state = undefined;
      byId('dashboard').hidden = true;
      byId('navigation').hidden = true;
      return;
    }
    let nextState;
    try { nextState = await api('state'); }
    catch (error) {
      if (selected === activePatient) selectPatient('');
      throw error;
    }
    if (selected !== activePatient) return;
    state = nextState;
    syncedAt = Date.now();
    byId('dashboard').hidden = false;
    byId('navigation').hidden = false;
    setView(activeView);
    render();
  });
  refreshQueue = request.catch(() => {});
  return request;
}

const now = () => state.now + Date.now() - syncedAt;
const grace = () => 30 * 60_000;
const status = dose => dose.taken_at ? 'Taken' : now() >= dose.due + grace(dose) ? 'Unconfirmed' : now() >= dose.due ? 'Due' : 'Upcoming';
const pill = label => '<span class="pill" data-status="' + safe(label) + '">' + safe(label) + '</span>';
const doseDetail = dose => dose.amount + ' · ' + time(dose.due);
const dayLength = 86_400_000;
const offset = 330 * 60_000;
const isoDay = value => new Date(value + offset).toISOString().slice(0, 10);
const todaysDoses = () => state.doses.filter(dose => dose.due >= state.start && dose.due < state.start + dayLength && !dose.demo);

function stopReading() {
  if (!speech) return;
  speech = undefined;
  window.speechSynthesis.cancel();
  byId('read-today').textContent = 'Read today aloud';
}

byId('read-today').addEventListener('click', () => {
  if (speech) {
    stopReading();
    return;
  }
  if (!state) return;
  const synthesis = window.speechSynthesis;
  const localVoices = synthesis?.getVoices().filter(voice => voice.localService && /^en\b/i.test(voice.lang)) ?? [];
  const voice = localVoices.find(item => item.lang.toLowerCase() === 'en-in') ?? localVoices[0];
  if (!voice || !window.SpeechSynthesisUtterance) {
    notice('Read aloud needs an on-device English voice in your browser.', true);
    return;
  }
  const current = now();
  const doses = todaysDoses();
  const pending = doses.filter(dose => !dose.taken_at);
  const appointment = state.appointments.find(item => item.due > current);
  const parts = [
    'Care plan for ' + state.person.name + '.',
    doses.length ? (doses.length - pending.length) + ' of ' + doses.length + ' doses marked taken today.' : 'No doses scheduled today.',
    ...pending.map(dose => dose.name + ', ' + dose.amount + ', scheduled for ' + time(dose.due) + '. ' + status(dose) + '.'),
    appointment ? 'Next appointment: ' + appointment.name + ', ' + date(appointment.due) + ' at ' + time(appointment.due) + ' India Standard Time.' : 'No upcoming appointments.'
  ];
  const message = new SpeechSynthesisUtterance(parts.join(' '));
  message.voice = voice;
  message.lang = voice.lang;
  message.rate = 0.88;
  const finish = () => {
    if (speech !== message) return false;
    speech = undefined;
    byId('read-today').textContent = 'Read today aloud';
    return true;
  };
  message.onend = finish;
  message.onerror = () => { if (finish()) notice('Could not read the care plan aloud.', true); };
  speech = message;
  byId('read-today').textContent = 'Stop reading';
  notice();
  try { synthesis.speak(message); }
  catch { if (finish()) notice('Could not read the care plan aloud.', true); }
});

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
  const lastWeek = state.start - 6 * dayLength;
  const recorded = state.doses.filter(dose => !dose.demo && dose.due >= lastWeek &&
    (dose.taken_at || status(dose) === 'Unconfirmed'));
  const confirmed = recorded.filter(dose => dose.taken_at).length;
  const appointment = state.appointments.find(item => item.due > current);
  const days = Array.from({ length: 7 }, (_, index) => {
    const start = lastWeek + index * dayLength;
    const entries = recorded.filter(dose => dose.due >= start && dose.due < start + dayLength);
    const taken = entries.filter(dose => dose.taken_at).length;
    return '<tr><th scope="row">' + safe(date(start)) + '</th><td>' + taken + '</td><td>' + (entries.length - taken) + '</td></tr>';
  });
  show('report-content', '<h2>' + safe(state.person.name) + '</h2>'
    + empty(date(lastWeek) + ' through ' + date(current))
    + empty(confirmed + ' confirmed · ' + (recorded.length - confirmed) + ' unconfirmed')
    + (appointment ? empty('Next appointment: ' + appointment.name + ' · ' + dayTime(appointment.due) + (appointment.location ? ' · ' + appointment.location : '')) : '')
    + (recorded.length ? '<table class="report-table"><caption>Dose records by day</caption><thead><tr><th scope="col">Day</th><th scope="col">Confirmed</th><th scope="col">Unconfirmed</th></tr></thead><tbody>' + days.join('') + '</tbody></table>'
      + '<h3>Dose details</h3>' + recorded.map(dose => row(dose.name, dose.amount + ' · ' + dayTime(dose.due), pill(status(dose)))).join('')
      : empty('No confirmed or unconfirmed dose records in this period.')));
}

function renderToday() {
  const current = now();
  const today = todaysDoses();
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
  byId('next-heading').parentElement.toggleAttribute('data-due', due.length > 0);
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
  const alarmText = due.length ? 'Dose due: ' + due.map(dose => dose.name).join(', ') : '';
  if (byId('alarm-message').textContent !== alarmText) byId('alarm-message').textContent = alarmText;
  byId('alarm').hidden = !due.length;
  if (!due.length) stopAlarm();
  if (armed && audio?.state === 'running' && due.some(dose => !sounded.has(dose.id))) {
    due.forEach(dose => sounded.add(dose.id));
    startAlarm();
  }
}

const controls = (entity, item) => button('edit-' + entity, item.id, 'Edit') + button('delete-' + entity, item.id, entity === 'medications' ? 'Retire' : 'Remove');
const deliveryLabels = { accepted: 'Accepted by Brevo', sending: 'Sending', failed: 'Failed', retry: 'Retry pending', review: 'Check Brevo logs', unconfigured: 'Provider not configured', suppressed: 'Suppressed' };
const reminderLabels = { upcoming: 'Upcoming dose', unconfirmed: 'Unconfirmed dose', appointment: 'Appointment', appointment_request: 'Appointment request', checkin: 'Requested check-in' };

function renderSchedule() {
  show('medication-list', state.medications.map(item => row(item.name, item.amount + ' · ' + item.time + ' IST · ' + (item.interval_days === 1 ? 'Daily' : 'Every ' + item.interval_days + ' days'), controls('medications', item))).join('') || empty('No medications yet.'));
  byId('open-appointment').hidden = !state.me.owner;
  byId('appointment-form').hidden = state.me.owner;
  byId('request-appointment-form').hidden = !state.me.owner || !state.doctors.length;
  byId('no-linked-doctors').hidden = !state.me.owner || Boolean(state.doctors.length);
  show('doctor-picker', '<option value="">Choose doctor</option>' + state.doctors.map(doctor => '<option value="' + safe(doctor.id) + '">' + safe(doctor.name) + '</option>').join(''));
  show('today-request-status', state.me.owner ? state.requests.slice(0, 3).map(item => empty(item.name + ' · ' + (item.status === 'pending' ? 'Awaiting ' + item.doctor_name : item.status === 'scheduled' ? 'Scheduled for ' + dayTime(item.due) : item.status))).join('') : '');
  show('appointment-requests', state.requests.filter(item => item.status !== 'scheduled').map(item => {
    const description = item.doctor_name + ' · ' + (item.status === 'pending' ? 'Awaiting response' : item.status);
    let actions = item.status === 'pending' && state.me.owner ? button('cancel-request', item.id, 'Cancel request') : '';
    if (item.status === 'pending' && state.me.relationship === 'Doctor') actions = '<form class="request-response" data-request="' + safe(item.id) + '"><label>Appointment time (IST)<input name="due" type="datetime-local" required></label><label>Location<input name="location" maxlength="100"></label><button class="primary">Accept and schedule</button></form>' + button('decline-request', item.id, 'Decline');
    return row(item.name, description, actions);
  }).join(''));
  show('appointment-list', state.appointments.map(item => row(item.name, dayTime(item.due) + (item.location ? ' · ' + item.location : ''), !state.me.owner && !item.status ? controls('appointments', item) : '')).join('') || empty('No appointments scheduled.'));
  show('week-plan', Array.from({ length: 7 }, (_, index) => {
    const day = state.start + index * dayLength;
    const schedule = state.medications.filter(item => {
      const [hour, minute] = item.time.split(':').map(Number);
      return day + (hour * 60 + minute) * 60_000 >= item.effective &&
        (item.start_day == null || (day >= item.start_day && ((day - item.start_day) / dayLength) % item.interval_days === 0)) &&
        (item.end_day == null || day <= item.end_day) && !item.skip_dates.includes('|' + isoDay(day) + '|');
    });
    return '<section><h3>' + safe(date(day)) + '</h3>' + (schedule.map(item => empty(item.time + ' · ' + item.name + ' · ' + item.amount)).join('') || empty('No doses scheduled')) + '</section>';
  }).join(''));
}

function render() {
  renderToday();
  byId('circle-owner').hidden = !state.me.owner;
  byId('circle-helper').hidden = state.me.owner;
  renderSchedule();
  show('access-list', state.contacts.filter(item => item.account && !item.revoked).map(item =>
    row(item.access_name, item.relationship + ' · Can view and manage your schedule')).join('') || empty('Only you can access your schedule right now.'));
  show('contact-list', state.contacts.map(item => {
    const access = item.declined_at ? 'Invitation declined' : item.revoked ? 'Access revoked' : item.account ? item.relationship
      : item.invite_expires && item.invite_expires <= now() ? 'Invitation expired' : item.member ? 'Invite pending' : 'Alerts only';
    return row(item.name, [item.email, item.phone, access, item.alerts && !item.declined_at ? 'Alerts on' : 'Alerts off'].filter(Boolean).join(' · '), controls('contacts', item) + (item.member && !item.revoked ? button('revoke', item.id, item.account ? 'Revoke access' : 'Cancel invitation') : ''));
  }).join('') || empty('Add a family member, caregiver, or doctor.'));
  show('delivery-list', state.deliveries.map(item => row(reminderLabels[item.kind], item.recipient + ' · ' + time(item.attempted), pill(deliveryLabels[item.state] || item.state))).join('') || empty('No reminders sent yet.'));
}

function tone(output) {
  const start = audio.currentTime;
  for (const [index, frequency] of [660, 880, 660, 880].entries()) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const at = start + index * .28;
    oscillator.type = 'triangle';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(.4, at + .035);
    gain.gain.exponentialRampToValueAtTime(.0001, at + .24);
    oscillator.connect(gain).connect(output);
    oscillator.start(at);
    oscillator.stop(at + .25);
  }
}

function stopAlarm() {
  clearInterval(alarmTimer);
  clearTimeout(alarmEnd);
  alarmTimer = undefined;
  alarmEnd = undefined;
  alarmGain?.disconnect();
  alarmGain = undefined;
  byId('silence-alarm').hidden = true;
}

function startAlarm() {
  if (alarmTimer) return;
  alarmGain = audio.createGain();
  alarmGain.connect(audio.destination);
  tone(alarmGain);
  alarmTimer = setInterval(() => tone(alarmGain), 3000);
  alarmEnd = setTimeout(stopAlarm, 30_000);
  byId('silence-alarm').hidden = false;
}

byId('silence-alarm').addEventListener('click', stopAlarm);
byId('sound').addEventListener('click', async () => {
  if (armed) {
    armed = false;
    stopAlarm();
  } else {
    try {
      audio ??= new AudioContext();
      await audio.resume();
      tone(audio.destination);
      armed = true;
      notice('Alarm sound enabled. Due doses can ring for up to 30 seconds on this open page.');
    } catch { notice('Sound is unavailable. On-screen alerts are active.', true); }
  }
  byId('sound').setAttribute('aria-pressed', String(armed));
  byId('sound').textContent = armed ? 'Alarm sound on' : 'Enable alarm sound';
});

function passcode(value, context, title = 'Save your sign-in code') {
  byId('passcode-title').textContent = title;
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
  form.querySelector('button.primary').textContent = form.id === 'contact-form' ? 'Add contact or invite' : 'Add ' + forms[form.id][1];
  form.querySelector('.cancel').hidden = true;
  if (form.id === 'contact-form') {
    byId('invite-label').hidden = false;
    byId('email-invite-label').hidden = false;
  }
}

async function perform(control, action) {
  control.disabled = true;
  notice();
  try { await action(); }
  catch (error) {
    notice(error.message, true);
    byId('notice').scrollIntoView({ block: 'nearest' });
  }
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
        values.emailInvite = !edit && form.elements.emailInvite.checked;
      }
      const result = await api(entity + (edit ? '/' + edit : ''), edit ? 'PATCH' : 'POST', values);
      cancelEdit(form);
      await refresh();
      if (result.passcode) {
        const delivery = result.delivery === 'accepted' ? 'Brevo accepted the invitation email. '
          : result.delivery ? 'Email delivery could not be confirmed. You can share the key privately. ' : 'Share the key privately. ';
        passcode(result.passcode, delivery + 'The invitation can be used once and expires after seven days.', 'Patient invite key');
      }
      else notice(edit ? 'Changes saved.' : 'Added successfully.');
    });
  });
}

for (const [id, path] of [['login-form', 'login'], ['profile-form', 'profiles'], ['account-form', 'accounts'], ['legacy-login-form', 'legacy-login'], ['login-setup-form', 'set-login']]) {
  const form = byId(id);
  form.addEventListener('submit', event => {
    event.preventDefault();
    perform(form.querySelector('.primary'), async () => {
      await api(path, 'POST', formValues(form));
      form.reset();
      activeView = 'today';
      await refresh();
    });
  });
}

byId('logout').addEventListener('click', event => perform(event.currentTarget, async () => {
  await api('logout', 'POST');
  auth();
}));
function selectPatient(id) {
  stopReading();
  stopAlarm();
  activePatient = id;
  state = undefined;
  byId('dashboard').hidden = true;
  byId('navigation').hidden = true;
  sounded.clear();
  for (const formId of Object.keys(forms)) cancelEdit(byId(formId));
  byId('request-appointment-form').reset();
  activeView = 'today';
}

byId('patient-cards').addEventListener('click', event => {
  const patient = event.target.closest('[data-patient]');
  if (!patient) return;
  selectPatient(activePatient === patient.dataset.patient ? '' : patient.dataset.patient);
  refresh().catch(error => notice(error.message, true));
});
byId('request-appointment-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  perform(form.querySelector('button'), async () => {
    await api('appointment-requests', 'POST', formValues(form));
    form.reset();
    await refresh();
    notice('Appointment requested. Your doctor will receive an alert.');
  });
});
byId('appointment-requests').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  perform(form.querySelector('button'), async () => {
    const values = formValues(form);
    values.due = Date.parse(values.due + '+05:30');
    await api('appointment-requests/' + form.dataset.request + '/accept', 'POST', values);
    await refresh();
    notice('Appointment scheduled.');
  });
});
function resetInviteReview() {
  reviewedInvite = '';
  byId('invite-preview').hidden = true;
  byId('invite-preview').textContent = '';
  byId('invite-relationship').hidden = true;
  byId('join-form').elements.relationship.required = false;
  byId('join-form').elements.relationship.value = '';
  byId('review-invite').textContent = 'Review invitation';
  byId('decline-invite').hidden = true;
}

byId('join-form').elements.key.addEventListener('input', resetInviteReview);
byId('join-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  const decision = !reviewedInvite ? 'preview' : event.submitter?.id === 'decline-invite' ? 'decline' : 'accept';
  perform(event.submitter || byId('review-invite'), async () => {
    const result = await api('join', 'POST', { ...values, decision });
    if (decision === 'preview') {
      if (form.elements.key.value !== values.key) return;
      reviewedInvite = values.key;
      byId('invite-preview').textContent = 'Invitation from ' + result.name;
      byId('invite-preview').hidden = false;
      byId('invite-relationship').hidden = false;
      form.elements.relationship.required = true;
      byId('review-invite').textContent = 'Accept invitation';
      byId('decline-invite').hidden = false;
      return;
    }
    form.reset();
    resetInviteReview();
    byId('join-panel').open = false;
    if (decision === 'accept') selectPatient(result.patient);
    await refresh();
    notice(decision === 'accept' ? 'Invitation accepted. Patient linked.' : 'Invitation declined.');
  });
});

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
      else if (input.name === 'start') input.value = item.start_day == null ? '' : isoDay(item.start_day);
      else if (input.name === 'end') input.value = item.end_day == null ? '' : isoDay(item.end_day);
      else if (input.name === 'interval') input.value = item.interval_days;
      else if (input.name === 'skip') input.value = item.skip_dates.split('|').filter(Boolean).join(', ');
      else if (input.name === 'alerts') input.checked = Boolean(item.alerts);
      else if (Object.hasOwn(item, input.name)) input.value = item[input.name];
    }
    if (entity === 'contacts') {
      byId('invite-label').hidden = true;
      byId('email-invite-label').hidden = true;
    }
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
    } else if (action.endsWith('-request')) {
      await api('appointment-requests/' + id + '/' + action.split('-')[0], 'POST');
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
      'cancel-request': 'Appointment request cancelled.',
      'decline-request': 'Appointment request declined.',
      revoke: 'Access revoked.'
    };
    notice(messages[action] || 'Entry removed.');
  });
});

const sync = () => refresh().catch(error => { if (state) notice(error.message, true); });
byId('print-report').addEventListener('click', () => window.print());
setInterval(() => { if (state && !document.hidden) renderToday(); }, 1000);
setInterval(() => { if (!byId('logout').hidden && !document.hidden) sync(); }, 8000);
document.addEventListener('visibilitychange', () => { if (!byId('logout').hidden && !document.hidden) sync(); });
window.addEventListener('pagehide', () => { stopReading(); stopAlarm(); });
refresh().catch(error => {
  if (byId('auth').hidden) {
    auth();
    notice(error.message, true);
  }
});
