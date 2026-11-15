import { initPreferences, inHindi, locale, tr } from './language.js';

const byId = id => document.getElementById(id);
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
const time = value => format(value, timeOptions);
const date = value => format(value, dateOptions);
const dayTime = value => date(value) + ' · ' + time(value);
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const label = value => safe(tr(value));
const empty = message => '<p>' + safe(message) + '</p>';
const button = (action, id, label, kind = 'quiet') => '<button class="' + kind + '" data-action="' + action + '" data-id="' + safe(id) + '">' + safe(tr(label)) + '</button>';
const row = (name, detail, actions = '') => '<div class="row"><div><strong>' + safe(name) + '</strong><p>' + safe(detail) + '</p></div><div class="actions">' + actions + '</div></div>';
let state;
let activePatient = '';
let editingHandoff = false;
let noticeMessage = '';
let careTeam = false;
let activeView = 'today';
let syncedAt = 0;
let refreshQueue = Promise.resolve();
let pendingRefreshes = 0;
let nextTodayUpdate = Infinity;
let audio;
let armed = false;
let speech;
let alarmTimer;
let alarmEnd;
let alarmGain;
let reviewedInvite = '';
let accountSlot = '';
try {
  accountSlot = sessionStorage.getItem('carecircle.account-slot') || Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem('carecircle.account-slot', accountSlot);
} catch { /* Use the standard browser session when tab storage is unavailable. */ }
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
const photoUrls = new Map();

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
  noticeMessage = message;
  element.textContent = tr(message);
  element.toggleAttribute('data-error', error);
}

async function api(path, method = 'GET', body) {
  const accountRoutes = ['login', 'legacy-login', 'set-login', 'logout', 'profiles', 'accounts', 'patients', 'join', 'invitations'];
  const suffix = accountRoutes.includes(path.split('/')[0]) ? '' : '?patient=' + encodeURIComponent(activePatient);
  const response = await fetch('/api/' + path + suffix, {
    method,
    headers: { ...(accountSlot && { 'X-Care-Slot': accountSlot }), ...(method !== 'GET' && { 'Content-Type': 'application/json' }) },
    ...(method !== 'GET' && { body: JSON.stringify(body ?? {}) })
  });
  if (method === 'GET' && path.endsWith('/photo') && response.ok && response.headers.get('content-type') === 'image/jpeg') return response.blob();
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The care service may still be waking up. Try again in a moment.');
  }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['login', 'legacy-login'].includes(path)) auth();
    throw Object.assign(new Error(result.error || 'Request failed.'), { status: response.status });
  }
  return result;
}

function auth() {
  stopReading();
  stopAlarm();
  clearPhotos();
  byId('change-dialog').close();
  byId('join-form').reset();
  resetInviteReview();
  state = undefined;
  activePatient = '';
  editingHandoff = false;
  careTeam = false;
  byId('patient-access').hidden = true;
  byId('no-patients').hidden = true;
  byId('login-setup').hidden = true;
  armed = false;
  sounded.clear();
  byId('sound').textContent = tr('Enable alarm sound');
  byId('sound').setAttribute('aria-pressed', 'false');
  byId('auth').hidden = false;
  byId('dashboard').hidden = true;
  byId('navigation').hidden = true;
  byId('logout').hidden = true;
  setAuthForm('login-form');
  byId('passcode-dialog').close();
  for (const id of Object.keys(forms)) cancelEdit(byId(id));
}

function setAuthForm(id) {
  for (const button of document.querySelectorAll('[data-auth]')) {
    const selected = button.dataset.auth === id;
    button.setAttribute('aria-pressed', String(selected));
    byId(button.dataset.auth).hidden = !selected;
  }
}

document.querySelector('.auth-card').addEventListener('click', event => {
  const id = event.target.closest('[data-auth]')?.dataset.auth;
  if (!id) return;
  notice();
  setAuthForm(id);
  byId(id).querySelector('input')?.focus();
});

function setView(view) {
  if (view !== 'today') stopReading();
  activeView = view;
  for (const element of document.querySelectorAll('.view')) element.hidden = element.id !== view;
  for (const item of document.querySelectorAll('#navigation [data-view]')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  loadVisiblePhotos();
}

function refresh() {
  pendingRefreshes++;
  const request = refreshQueue.then(async () => {
    const { patients, account, inbox = [], visits = [] } = await api('patients');
    careTeam = account.kind === 'care-team';
    const doctorDashboard = account.workspace === 'doctor';
    byId('access-nav').hidden = doctorDashboard;
    byId('access-nav').textContent = tr(careTeam ? 'Care Circle' : 'People & access');
    byId('access-heading').textContent = tr(careTeam ? 'Care Circle' : 'People & access');
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
    byId('patient-access').hidden = !careTeam || Boolean(selected);
    byId('back-patients').hidden = !careTeam;
    byId('back-patients').textContent = tr('← Back to patient list') + (inbox.length ? ' · ' + inbox.length + ' ' + tr(inbox.length === 1 ? 'new invitation' : 'new invitations') : '');
    byId('invitations-panel').hidden = !careTeam;
    byId('doctor-visits-panel').hidden = !doctorDashboard;
    const relationships = ['Family', 'Caregiver', 'Doctor', 'Other'].map(value => '<option value="' + value + '">' + label(value) + '</option>').join('');
    show('invitations-list', inbox.map(invite => '<form class="inbox-invite" data-invite="' + safe(invite.id) + '"><h3>' + safe(invite.name) + '</h3><label>' + label('Your relationship') + '<select name="relationship" required><option value="">' + label('Select relationship') + '</option>' + relationships + '</select></label><div class="actions"><button class="primary" value="accept">' + label('Accept') + '</button><button class="quiet" value="decline" formnovalidate>' + label('Decline') + '</button></div></form>').join('') || empty(tr('No pending invitations.')));
    show('doctor-visits-list', visits.map(visit => row(visit.patient_name, visit.name + ' · ' + (visit.status === 'pending' ? tr('Awaiting scheduling') : tr('Scheduled') + ' · ' + dayTime(visit.due)),
      '<button class="quiet" data-patient="' + safe(visit.patient) + '" data-destination="appointments">' + label('Open appointment') + '</button>')).join('') || empty(tr('No upcoming appointments or requests.')));
    show('patient-cards', patients.map(item => {
      const labels = [tr(item.relationship)];
      if (item.overdue) labels.push(item.overdue + ' ' + tr('overdue'));
      if (item.pending) labels.push(item.pending + ' ' + tr(item.pending === 1 ? 'appointment request' : 'appointment requests'));
      return '<button class="patient-card" data-patient="' + safe(item.id) + '" aria-pressed="' + (selected === item.id) + '" data-priority="' + (item.overdue ? 'overdue' : item.pending ? 'pending' : 'normal') + '"><strong>' + safe(item.name) + '</strong><span>' + safe(labels.filter(Boolean).join(' · ')) + '</span></button>';
    }).join(''));
    byId('patient-heading').textContent = tr(doctorDashboard ? 'Doctor dashboard' : 'Family & caregiver dashboard') + ' · ' + account.name;
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
      if (error.status === 404 && selected === activePatient) selectPatient('');
      throw error;
    }
    if (selected !== activePatient) return;
    state = nextState;
    syncedAt = Date.now();
    byId('dashboard').hidden = false;
    byId('navigation').hidden = false;
    setView(activeView);
    render();
  }).finally(() => pendingRefreshes--);
  refreshQueue = request.catch(() => {});
  return request;
}

const now = () => state.now + Date.now() - syncedAt;
const grace = () => state.doseGrace || 5 * 60_000;
const status = dose => dose.taken_at ? 'Taken' : now() >= dose.due + grace(dose) ? 'Unconfirmed' : now() >= dose.due ? 'Due' : 'Upcoming';
const pill = label => '<span class="pill" data-status="' + safe(label) + '">' + safe(tr(label)) + '</span>';
const doseDetail = dose => dose.amount + ' · ' + time(dose.due);
const dayLength = 86_400_000;
const offset = 330 * 60_000;
const isoDay = value => new Date(value + offset).toISOString().slice(0, 10);
const todaysDoses = () => state.doses.filter(dose => dose.due >= state.start && dose.due < state.start + dayLength && !dose.demo);

function photoMarkup(medication) {
  if (!medication?.photo_revision) return '';
  return '<img class="medication-photo" data-medication="' + safe(medication.id) + '" data-revision="' + safe(medication.photo_revision) + '" alt="' + safe(tr('Medication photo') + ' · ' + medication.name) + '" hidden>';
}

function clearPhotos() {
  for (const entry of photoUrls.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  photoUrls.clear();
  for (const image of document.querySelectorAll('[data-revision]')) {
    image.removeAttribute('src');
    delete image.dataset.loading;
    image.hidden = true;
  }
}

function loadVisiblePhotos() {
  if (!state) return;
  for (const img of byId(activeView)?.querySelectorAll('[data-revision]') ?? []) {
    const { medication, revision } = img.dataset;
    let entry = photoUrls.get(revision);
    if (!entry) {
      const patient = activePatient;
      entry = {};
      photoUrls.set(revision, entry);
      entry.ready = api('medications/' + medication + '/photo').then(blob => {
        if (activePatient !== patient || photoUrls.get(revision) !== entry) return '';
        entry.url = URL.createObjectURL(blob);
        return entry.url;
      }).catch(() => '');
    }
    if (img.dataset.loading) continue;
    img.dataset.loading = 'true';
    void entry.ready.then(url => {
      if (!url || !img.isConnected) return;
      img.src = url;
      img.hidden = false;
    });
  }
}

async function resizeMedicationPhoto(file) {
  if (!file.type.startsWith('image/') || file.size > 12_000_000) throw new Error('Choose an image under 12 MB.');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(1, 620 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [.82, .65, .48]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (jpeg && jpeg.length <= 166_000) return jpeg;
    }
    throw new Error('The compressed photo is still too large.');
  } finally {
    URL.revokeObjectURL(source);
  }
}

function stopReading() {
  if (!speech) return;
  const current = speech;
  speech = undefined;
  if (current.sources) {
    current.controller.abort();
    for (const source of current.sources) source.stop();
  } else {
    window.speechSynthesis?.cancel();
  }
  byId('read-today').textContent = tr('Read today aloud');
}

async function playAudioOverview(doses, pending, appointment) {
  const playback = { sources: [], controller: new AbortController() };
  const current = now();
  const clips = [];
  if (pending.some(dose => dose.due <= current && current < dose.due + grace())) clips.push('due');
  if (pending.some(dose => dose.due + grace() <= current)) clips.push('overdue');
  if (pending.some(dose => dose.due > current)) clips.push('upcoming');
  if (!pending.length) clips.push(doses.length ? 'complete' : 'no-doses');
  clips.push(appointment ? 'appointment' : 'no-appointments');
  speech = playback;
  byId('read-today').textContent = tr('Stop reading');
  notice(inHindi() ? 'छोटा अंग्रेज़ी ऑडियो चल रहा है। दवाओं के नाम और समय आज के पेज पर हैं।' : 'Playing a short audio overview. Medication names and times are on Today.');
  try {
    audio ??= new AudioContext();
    await audio.resume();
    const buffers = await Promise.all(clips.map(async clip => {
      const response = await fetch('/voice/' + clip + '.wav', { signal: playback.controller.signal });
      if (!response.ok) throw new Error('Audio clip unavailable');
      return audio.decodeAudioData(await response.arrayBuffer());
    }));
    if (speech !== playback) return;
    let at = audio.currentTime;
    for (const buffer of buffers) {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.start(at);
      playback.sources.push(source);
      at += buffer.duration + 0.18;
    }
    playback.sources.at(-1).onended = () => {
      if (speech !== playback) return;
      speech = undefined;
      byId('read-today').textContent = tr('Read today aloud');
    };
  } catch {
    if (speech !== playback) return;
    stopReading();
    notice('Could not play the audio overview. The care plan is still shown on Today.', true);
  }
}

byId('read-today').addEventListener('click', () => {
  if (speech) {
    stopReading();
    return;
  }
  if (!state) return;
  const synthesis = window.speechSynthesis;
  const preferred = inHindi() ? /^hi\b/i : /^en\b/i;
  const localVoices = synthesis?.getVoices().filter(voice => voice.localService && preferred.test(voice.lang)) ?? [];
  const voice = localVoices.find(item => item.lang.toLowerCase() === locale().toLowerCase()) ?? localVoices[0];
  const current = now();
  const doses = todaysDoses();
  const pending = doses.filter(dose => !dose.taken_at);
  const appointment = state.appointments.find(item => item.due > current);
  if (!voice || !window.SpeechSynthesisUtterance) {
    void playAudioOverview(doses, pending, appointment);
    return;
  }
  const parts = inHindi() ? [
    state.person.name + ' की आज की देखभाल।',
    doses.length ? doses.length + ' में से ' + (doses.length - pending.length) + ' खुराकें ली गईं।' : 'आज कोई खुराक तय नहीं है।',
    ...pending.map(dose => dose.name + ', ' + dose.amount + ', समय ' + time(dose.due) + '। ' + tr(status(dose)) + '।'),
    appointment ? 'अगला अपॉइंटमेंट: ' + appointment.name + ', ' + date(appointment.due) + ', समय ' + time(appointment.due) + '।' : 'कोई आगामी अपॉइंटमेंट नहीं है।'
  ] : [
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
    byId('read-today').textContent = tr('Read today aloud');
    return true;
  };
  message.onend = finish;
  message.onerror = () => { if (finish()) notice('Could not read the care plan aloud.', true); };
  speech = message;
  byId('read-today').textContent = tr('Stop reading');
  notice();
  try { synthesis.speak(message); }
  catch { if (finish()) notice('Could not read the care plan aloud.', true); }
});

function followupRow(item, checkin = false) {
  const name = checkin ? tr('Check-in requested') : item.name;
  let detail = checkin ? dayTime(item.requested_at) : tr('Dose unconfirmed') + ' · ' + dayTime(item.due);
  if (item.claimed_by) {
    detail = item.completed_at
      ? tr('Caller') + ': ' + item.claimed_by + ' · ' + tr('Completed') + ' ' + dayTime(item.completed_at)
      : tr('Following up') + ': ' + item.claimed_by + ' · ' + time(item.claimed_at);
  }
  const notifications = (state.handoffNotices || []).filter(entry => entry.event === item.id);
  if (notifications.length) detail += ' · ' + notifications.map(entry =>
    entry.name + (entry.kind.endsWith('_backup') ? ' ' + tr('(backup)') : '') + ' · ' + tr('Email sent') + ' ' + time(entry.attempted)).join(', ');
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
    + empty(date(lastWeek) + ' – ' + date(current))
    + empty(confirmed + ' ' + tr('Confirmed') + ' · ' + (recorded.length - confirmed) + ' ' + tr('Unconfirmed'))
    + (appointment ? empty(tr('Next appointment') + ': ' + appointment.name + ' · ' + dayTime(appointment.due) + (appointment.location ? ' · ' + appointment.location : '')) : '')
    + (recorded.length ? '<table class="report-table"><caption>' + label('Dose records by day') + '</caption><thead><tr><th scope="col">' + label('Day') + '</th><th scope="col">' + label('Confirmed') + '</th><th scope="col">' + label('Unconfirmed') + '</th></tr></thead><tbody>' + days.join('') + '</tbody></table>'
      + '<h3>' + label('Dose details') + '</h3>' + recorded.map(dose => row(dose.name, dose.amount + ' · ' + dayTime(dose.due), pill(status(dose)))).join('')
      : empty(tr('No confirmed or unconfirmed dose records in this period.'))));
}

function todayAppointment() {
  const upcoming = state.appointments.find(item => item.due > now());
  return upcoming?.due < state.start + dayLength ? upcoming : null;
}

function renderToday() {
  const current = now();
  const today = todaysDoses();
  // Between these times the visible dose and appointment statuses stay the same.
  nextTodayUpdate = state.appointments.find(item => item.due > current)?.due ?? Infinity;
  for (const dose of state.doses) {
    if (dose.taken_at || dose.demo) continue;
    const transition = current < dose.due ? dose.due : dose.due + grace();
    if (transition > current) nextTodayUpdate = Math.min(nextTodayUpdate, transition);
  }
  const due = today.filter(dose => !dose.taken_at && dose.due <= current && current < dose.due + grace(dose));
  const next = due[0] ?? today.find(dose => !dose.taken_at && dose.due > current);
  const appointment = state.appointments.find(item => item.due > current);
  const followups = state.doses.filter(dose => (!dose.taken_at && status(dose) === 'Unconfirmed') || dose.claimed_at).slice(-12).reverse();
  const taken = today.filter(dose => dose.taken_at).length;
  byId('dose-progress').hidden = today.length === 0;
  byId('dose-count').textContent = inHindi() ? today.length + ' में से ' + taken + ' खुराकें ली गईं' : taken + ' of ' + today.length + ' taken';
  byId('dose-meter').max = today.length || 1;
  byId('dose-meter').value = taken;
  byId('date').textContent = date(current);
  byId('welcome').textContent = inHindi() ? state.person.name + ' की आज की देखभाल' : 'Today for ' + state.person.name;
  byId('next-heading').textContent = tr(due.length ? 'Dose due now' : 'Next dose');
  byId('next-heading').parentElement.toggleAttribute('data-due', due.length > 0);
  show('next-dose', next
    ? '<p class="dose-time">' + safe(time(next.due)) + '</p><p class="metric">' + safe(next.name) + '</p>' + empty(next.amount)
      + photoMarkup(state.medications.find(item => item.id === next.medication))
      + (due.length ? button('taken', next.id, 'Mark taken', 'primary hero-action') : '')
    : '<p class="metric">' + tr(today.length > 0 && taken === today.length ? 'All doses recorded' : 'No upcoming doses today') + '</p>');
  show('next-appointment', appointment
    ? '<p class="appointment-date">' + safe(dayTime(appointment.due)) + '</p><p class="metric">' + safe(appointment.name) + '</p>' + (appointment.location ? empty(appointment.location) : '')
    : empty(tr('No upcoming appointments.')));
  const sameDay = state.me.owner && todayAppointment();
  const pendingChange = sameDay && state.requests.some(item => item.id === sameDay.id && item.proposal_state === 'pending');
  byId('open-appointment').textContent = tr(sameDay ? pendingChange ? 'Review change request' : 'Request a change'
    : state.me.canRequestAppointment ? 'Request an appointment' : 'Open appointments');
  show('today-doses', today.map(dose => row(dose.name, doseDetail(dose), pill(status(dose)) + (!dose.taken_at && dose.due <= current && dose !== due[0] ? button('taken', dose.id, 'Mark taken', 'primary') : ''))).join('') || empty(tr('Add a medication in Schedule.')));
  byId('request-checkin').hidden = !state.me.owner || state.checkins.some(item => !item.completed_at);
  show('followups', [...state.checkins.map(item => followupRow(item, true)), ...followups.map(dose => followupRow(dose))].join('') || empty(tr('No follow-ups to show.')));
  show('history-list', state.doses.filter(dose => dose.due <= now()).slice(-30).reverse().map(dose => row(dose.name, dayTime(dose.due) + (dose.taken_by ? ' · ' + tr('Recorded by') + ' ' + dose.taken_by : ''), pill(status(dose)) + (!today.includes(dose) && !dose.taken_at ? button('taken', dose.id, 'Mark taken') : ''))).join('') || empty(tr('No dose history yet.')));
  renderReport(current);
  const alarmText = due.length ? (inHindi() ? 'खुराक का समय: ' : 'Dose due: ') + due.map(dose => dose.name).join(', ') : '';
  if (byId('alarm-message').textContent !== alarmText) byId('alarm-message').textContent = alarmText;
  byId('alarm').hidden = !state.me.owner || !due.length;
  if (!state.me.owner || !due.length) stopAlarm();
  if (state.me.owner && armed && audio?.state === 'running' && due.some(dose => !sounded.has(dose.id))) {
    due.forEach(dose => sounded.add(dose.id));
    startAlarm();
  }
  if (activeView === 'today') loadVisiblePhotos();
}

const controls = (entity, item) => button('edit-' + entity, item.id, 'Edit') + button('delete-' + entity, item.id, entity === 'medications' ? 'Retire' : 'Remove');
const deliveryLabels = { accepted: 'Email sent', sending: 'Sending', failed: 'Failed', retry: 'Retry pending', review: 'Check delivery logs', unconfigured: 'Provider not configured', suppressed: 'Suppressed' };
const reminderLabels = { upcoming: 'Upcoming dose', unconfirmed: 'Unconfirmed dose', appointment: 'Appointment', appointment_request: 'Appointment request', appointment_change: 'Alternate appointment time', checkin: 'Requested check-in', checkin_backup: 'Check-in backup', dose_backup: 'Dose follow-up backup', refill: 'Refill reminder' };

const personOptions = (people, selected, placeholder) => '<option value="">' + safe(tr(placeholder)) + '</option>' +
  people.map(person => '<option value="' + safe(person.id) + '"' + (person.id === selected ? ' selected' : '') + '>' + safe(person.name + ' · ' + tr(person.relationship)) + '</option>').join('');

function renderRefills() {
  const tracked = state.refills || [];
  show('refill-cards', state.medications.map(medication => {
    const refill = tracked.find(item => item.medication === medication.id);
    const low = refill?.runout && refill.remaining <= refill.threshold;
    const count = refill ? refill.remaining + ' ' + tr('doses left') : tr('Refill tracking is off.');
    const timing = refill?.runout ? empty(tr('First dose without supply') + ': ' + dayTime(refill.runout)) : '';
    const preferences = state.me.owner
      ? '<label>' + label('Remind me at this many doses left') + '<input name="threshold" type="number" min="0" max="90" required value="' + (refill?.threshold ?? 3) + '"></label>'
        + '<label>' + label('Send the refill email to') + '<select name="contact">' + personOptions(state.people || [], refill?.contact, 'Me') + '</select></label>'
      : '';
    const form = state.me.owner || refill
      ? '<form class="stack" data-refill="' + safe(medication.id) + '"><label>' + label('Counted doses left') + '<input name="quantity" type="number" min="0" max="10000" required value="' + (refill?.remaining ?? '') + '"></label>'
        + preferences + '<div class="actions"><button class="primary">' + label('Save dose count') + '</button>'
        + (state.me.owner && refill ? button('disable-refill', medication.id, 'Stop tracking') : '') + '</div></form>'
      : '';
    return '<article class="card"' + (low ? ' data-low' : '') + '><h2>' + safe(medication.name) + '</h2>' + empty(count) + timing + form + '</article>';
  }).join('') || empty(tr('Add a medication in Schedule to track refills.')));
}

function renderHandoff() {
  const people = state.people || [];
  const form = byId('handoff-form');
  const rule = state.handoff;
  if (!state.me.owner || !rule || people.length < 2) editingHandoff = false;
  form.hidden = !state.me.owner || people.length < 2 || Boolean(rule && !editingHandoff);
  byId('handoff-empty').hidden = !state.me.owner || people.length >= 2;
  byId('handoff-saved').hidden = !state.me.owner || !rule || editingHandoff;
  byId('edit-handoff').disabled = people.length < 2;
  byId('cancel-handoff').hidden = !rule;
  if (rule) {
    const contact = id => {
      const person = people.find(item => item.id === id);
      return person ? person.name + ' · ' + tr(person.relationship) : tr('Contact unavailable');
    };
    show('handoff-summary',
      row(tr('Primary contact'), contact(rule.primary_member)) +
      row(tr('Backup contact'), contact(rule.backup_member)) +
      row(tr('Wait before notifying backup (minutes)'), String(rule.wait_minutes)));
  }
  const version = [activePatient, rule?.primary_member, rule?.backup_member, rule?.wait_minutes, ...people.map(item => item.id)].join('|');
  if (form.dataset.version === version && form.dataset.language === locale()) return;
  const selections = !form.hidden && form.dataset.version === version
    ? [form.elements.primary.value, form.elements.backup.value, form.elements.wait.value] : null;
  form.dataset.version = version;
  form.dataset.language = locale();
  show('handoff-primary', personOptions(people, rule?.primary_member, 'Choose primary'));
  show('handoff-backup', personOptions(people, rule?.backup_member, 'Choose backup'));
  form.elements.primary.value = people.some(item => item.id === rule?.primary_member) ? rule.primary_member : '';
  form.elements.backup.value = people.some(item => item.id === rule?.backup_member) ? rule.backup_member : '';
  form.elements.wait.value = rule?.wait_minutes ?? 15;
  if (selections) [form.elements.primary.value, form.elements.backup.value, form.elements.wait.value] = selections;
}

function visitForm(item, action, fields, label) {
  return '<form class="visit-form" data-request="' + safe(item.id) + '" data-mode="' + action + '">' + fields + '<button class="primary">' + safe(tr(label)) + '</button></form>';
}

function visitDetails(item) {
  const patient = state.me.owner;
  const doctor = state.me.relationship === 'Doctor';
  const future = item.status === 'scheduled' && item.due > now();
  const completed = item.status === 'scheduled' && !future;
  const questions = safe(tr('Questions for the doctor'));
  const summary = safe(tr('Visit summary'));
  const questionsField = '<label>' + questions + '<textarea name="questions" rows="3" maxlength="1000">' + safe(item.questions) + '</textarea></label>';
  const parts = [];
  if (item.questions) parts.push('<p class="visit-notes"><strong>' + questions + '</strong><br>' + safe(item.questions) + '</p>');
  if (patient && (future || item.status === 'pending')) parts.push(visitForm(item, 'questions', questionsField, 'Save questions'));
  if (item.proposal_state) {
    const decision = item.proposal_state === 'pending' ? (future ? 'Awaiting doctor’s reply' : 'Proposal expired') : item.proposal_state === 'accepted' ? 'Alternate time accepted' : 'Alternate time declined';
    parts.push(empty(tr(decision) + ' · ' + dayTime(item.proposed_due)));
    if (item.proposal_reason) parts.push('<p class="visit-notes"><strong>' + safe(tr('Reason for the change')) + '</strong><br>' + safe(item.proposal_reason) + '</p>');
  }
  if (patient && future) parts.push(button('change-visit', item.id, 'Request a change'));
  if (doctor && future && item.proposal_state === 'pending') {
    const key = item.id + '|' + item.proposed_due;
    parts.push('<div class="actions">' + button('accept-proposal', key, 'Accept alternate time', 'primary') + button('decline-proposal', key, 'Decline alternate time') + '</div>');
  }
  if (item.visit_summary) parts.push('<p class="visit-notes"><strong>' + summary + '</strong><br>' + safe(item.visit_summary) + '</p>');
  if (doctor && completed) parts.push(visitForm(item, 'summary', '<label>' + summary + '<textarea name="summary" rows="4" maxlength="1500" required>' + safe(item.visit_summary) + '</textarea></label>', 'Save visit summary'));
  return parts.join('');
}

function renderSchedule() {
  show('medication-list', state.medications.map(item => '<article class="medication-entry">' + row(item.name, item.amount + ' · ' + item.time + ' IST · ' + (item.interval_days === 1 ? tr('Daily') : tr('Every {days} days').replace('{days}', item.interval_days))
    + (item.updated_by ? ' · ' + tr('Updated by') + ' ' + item.updated_by + ' · ' + tr('Effective') + ' ' + dayTime(Math.max(item.effective, item.start_day || 0)) : ''), controls('medications', item)) + photoMarkup(item)
    + '<form class="photo-form" data-photo="' + safe(item.id) + '"><label>' + safe(tr('Medication photo')) + '<input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/avif,image/heic" required></label>'
    + '<div class="actions"><button class="quiet">' + safe(tr('Add or replace photo')) + '</button>'
    + (item.photo_revision ? '<button type="button" class="quiet" data-action="remove-photo" data-id="' + safe(item.id) + '">' + safe(tr('Remove photo')) + '</button>' : '') + '</div></form></article>').join('') || empty(tr('No medications yet.')));
  const canRequest = state.me.canRequestAppointment ?? state.me.owner;
  byId('appointment-form').hidden = state.me.relationship !== 'Doctor';
  byId('request-appointment-form').hidden = !canRequest || !state.doctors.length;
  byId('no-linked-doctors').hidden = !canRequest || Boolean(state.doctors.length);
  byId('no-linked-doctors').textContent = tr(state.me.owner ? 'Invite your doctor from People & access before requesting an appointment.' : 'Ask the patient to link their doctor before requesting an appointment.');
  show('doctor-picker', '<option value="">' + safe(tr('Choose doctor')) + '</option>' + state.doctors.map(doctor => '<option value="' + safe(doctor.id) + '">' + safe(doctor.name) + '</option>').join(''));
  const todayVisit = todayAppointment();
  const awaitingChange = todayVisit && state.requests.find(item => item.id === todayVisit.id && item.proposal_state === 'pending');
  show('today-request-status', state.me.owner ? awaitingChange ? empty(tr('Change requested') + ' · ' + dayTime(awaitingChange.proposed_due))
    : !todayVisit ? state.requests.filter(item => item.status === 'pending').slice(0, 2).map(item => empty(item.name + ' · ' + tr('Awaiting response') + ' · ' + item.doctor_name)).join('') : '' : '');
  show('appointment-requests', state.requests.map(item => {
    const description = item.doctor_name + ' · ' + (item.status === 'scheduled' ? tr('Scheduled') + ' · ' + dayTime(item.due) + (item.location ? ' · ' + item.location : '') : tr(item.status === 'pending' ? 'Awaiting response' : item.status));
    let actions = item.status === 'pending' && state.me.owner ? button('cancel-request', item.id, 'Cancel request') : '';
    if (item.status === 'pending' && state.me.relationship === 'Doctor') actions = '<form class="request-response" data-request="' + safe(item.id) + '"><label>' + safe(tr('Appointment time (IST)')) + '<input name="due" type="datetime-local" required></label><label>' + safe(tr('Location')) + '<input name="location" maxlength="100"></label><button class="primary">' + safe(tr('Accept and schedule')) + '</button></form>' + button('decline-request', item.id, 'Decline');
    return '<article class="visit-entry">' + row(item.name, description, actions) + visitDetails(item) + '</article>';
  }).join(''));
  const standalone = state.appointments.filter(item => !state.requests.some(request => request.id === item.id));
  show('appointment-list', standalone.map(item => row(item.name, tr('Scheduled') + ' · ' + dayTime(item.due) + (item.location ? ' · ' + item.location : ''), state.me.relationship === 'Doctor' && !item.status ? controls('appointments', item) : state.me.owner && item.due > now() ? button('change-visit', item.id, 'Request a change') : '')).join('') || (state.requests.length ? '' : empty(tr('No appointments scheduled.'))));
  show('week-plan', Array.from({ length: 7 }, (_, index) => {
    const day = state.start + index * dayLength;
    const schedule = state.medications.filter(item => {
      const [hour, minute] = item.time.split(':').map(Number);
      return day + (hour * 60 + minute) * 60_000 >= item.effective &&
        (item.start_day == null || (day >= item.start_day && ((day - item.start_day) / dayLength) % item.interval_days === 0)) &&
        (item.end_day == null || day <= item.end_day) && !item.skip_dates.includes('|' + isoDay(day) + '|');
    });
    return '<section><h3>' + safe(date(day)) + '</h3>' + (schedule.map(item => empty(item.time + ' · ' + item.name + ' · ' + item.amount)).join('') || empty(tr('No doses scheduled'))) + '</section>';
  }).join(''));
  loadVisiblePhotos();
}

function render() {
  renderToday();
  byId('sound').hidden = !state.me.owner;
  const canSearchMedicines = state.me.relationship === 'Doctor';
  if (canSearchMedicines) byId('medication-name').setAttribute('list', 'medicine-suggestions');
  else byId('medication-name').removeAttribute('list');
  byId('medication-search-help').hidden = !canSearchMedicines;
  byId('circle-owner').hidden = !state.me.owner;
  byId('circle-helper').hidden = state.me.owner;
  renderSchedule();
  renderRefills();
  renderHandoff();
  show('access-list', state.contacts.filter(item => item.account && !item.revoked).map(item =>
    row(item.access_name, tr(item.relationship) + ' · ' + tr('Can view and manage your schedule'))).join('') || empty(tr('Only you can access your schedule right now.')));
  show('contact-list', state.contacts.map(item => {
    const access = item.declined_at ? 'Invitation declined' : item.revoked ? 'Access revoked' : item.account ? item.relationship
      : item.invite_expires && item.invite_expires <= now() ? 'Invitation expired' : item.member ? 'Invite pending' : 'Alerts only';
    return row(item.name, [item.email, item.phone, tr(access), tr(item.alerts && !item.declined_at ? 'Alerts on' : 'Alerts off')].filter(Boolean).join(' · '), controls('contacts', item) + (item.member && !item.revoked ? button('revoke', item.id, item.account ? 'Revoke access' : 'Cancel invitation') : ''));
  }).join('') || empty(tr('Add a family member, caregiver, or doctor.')));
  show('delivery-list', state.deliveries.map(item => row(tr(reminderLabels[item.kind]), item.recipient + ' · ' + time(item.attempted), pill(item.state === 'accepted' && item.channel === 'sms' ? 'SMS sent' : deliveryLabels[item.state] || item.state))).join('') || empty(tr('No reminders sent yet.')));
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
  if (!state?.me.owner) return;
  if (armed) {
    armed = false;
    stopAlarm();
  } else {
    try {
      audio ??= new AudioContext();
      await audio.resume();
      armed = true;
      renderToday();
      if (!alarmTimer) tone(audio.destination);
      notice('Alarm sound enabled. Due doses can ring for up to 30 seconds on this open page.');
    } catch { notice('Sound is unavailable. On-screen alerts are active.', true); }
  }
  byId('sound').setAttribute('aria-pressed', String(armed));
  byId('sound').textContent = tr(armed ? 'Alarm sound on' : 'Enable alarm sound');
});

function passcode(value, context, title = 'Save your sign-in code') {
  byId('passcode-title').textContent = tr(title);
  byId('passcode-value').value = value.length === 6 ? value : value.match(/.{1,8}/g).join('-');
  byId('passcode-context').textContent = tr(context);
  byId('passcode-dialog').showModal();
}
byId('passcode-dialog').addEventListener('close', () => { byId('passcode-value').value = ''; });
byId('copy-code').addEventListener('click', async () => {
  const input = byId('passcode-value');
  try {
    await navigator.clipboard.writeText(input.value);
    byId('copy-code').textContent = tr('Copied');
  } catch { input.select(); }
});
byId('passcode-dialog').addEventListener('close', () => { byId('copy-code').textContent = tr('Copy passcode'); });

const forms = {
  'medication-form': ['medications', 'medication'],
  'appointment-form': ['appointments', 'appointment'],
  'contact-form': ['contacts', 'contact']
};
const formValues = form => Object.fromEntries(new FormData(form));
function cancelEdit(form) {
  form.reset();
  delete form.dataset.edit;
  renderFormButton(form);
  form.querySelector('.cancel').hidden = true;
  if (form.id === 'contact-form') {
    byId('invite-label').hidden = false;
    byId('email-invite-label').hidden = false;
  }
}

function renderFormButton(form) {
  form.querySelector('button.primary').textContent = tr(form.dataset.edit ? 'Save changes' : form.id === 'contact-form' ? 'Add contact or invite' : 'Add ' + forms[form.id][1]);
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
      if (result.passcode) passcode(result.passcode, 'Share this code privately. It expires after 24 hours and can be used once.', 'Patient invite code');
      else if (result.inApp) notice('Invitation sent to their CareCircle account.');
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
  clearPhotos();
  byId('change-dialog').close();
  activePatient = id;
  editingHandoff = false;
  state = undefined;
  byId('dashboard').hidden = true;
  byId('navigation').hidden = true;
  sounded.clear();
  for (const formId of Object.keys(forms)) cancelEdit(byId(formId));
  byId('request-appointment-form').reset();
  activeView = 'today';
}

function openChangeForm(visit) {
  if (!state.me.owner || !visit) return;
  const form = byId('change-form');
  const existing = state.requests.find(item => item.id === visit.id);
  const chooseDoctor = !visit.status;
  form.reset();
  form.dataset.visit = visit.id;
  form.dataset.resource = chooseDoctor ? 'appointments' : 'appointment-requests';
  byId('change-error').hidden = true;
  byId('change-context').textContent = visit.name + ' · ' + dayTime(visit.due);
  byId('change-doctor-label').hidden = !chooseDoctor;
  form.elements.doctor.required = chooseDoctor;
  show('change-doctor', '<option value="">' + safe(tr('Choose doctor')) + '</option>' + state.doctors.map(person => '<option value="' + safe(person.id) + '">' + safe(person.name) + '</option>').join(''));
  form.elements.doctor.value = state.doctors.some(person => person.id === visit.doctor) ? visit.doctor : state.doctors.length === 1 ? state.doctors[0].id : '';
  form.elements.reason.value = existing?.proposal_state === 'pending' ? existing.proposal_reason : '';
  form.elements.due.min = new Date(now() + offset + 60_000).toISOString().slice(0, 16);
  form.elements.due.value = existing?.proposal_state === 'pending' ? new Date(existing.proposed_due + offset).toISOString().slice(0, 16) : '';
  if (chooseDoctor && !state.doctors.length) {
    notice('Link a doctor in People & access before requesting a change.', true);
    return;
  }
  byId('change-dialog').showModal();
}

byId('cancel-change').addEventListener('click', () => byId('change-dialog').close());
byId('open-appointment').addEventListener('click', () => {
  if (!state) return;
  const visit = state.me.owner && todayAppointment();
  if (visit && !state.requests.some(item => item.id === visit.id && item.proposal_state === 'pending')) {
    openChangeForm(visit);
    return;
  }
  setView('appointments');
  if (!visit && state.me.canRequestAppointment && !byId('request-appointment-form').hidden) {
    byId('request-appointment-form').querySelector('select').focus();
  }
});
byId('change-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('.primary');
  submit.disabled = true;
  byId('change-error').hidden = true;
  try {
    const values = formValues(form);
    values.due = Date.parse(values.due + '+05:30');
    const action = form.dataset.resource === 'appointments' ? 'request-change' : 'propose';
    await api(form.dataset.resource + '/' + form.dataset.visit + '/' + action, 'POST', values);
    byId('change-dialog').close();
    await refresh();
    notice(tr('Change requested'));
  } catch (error) {
    byId('change-error').textContent = tr(error.message);
    byId('change-error').hidden = false;
  } finally { submit.disabled = false; }
});

byId('medication-list').addEventListener('submit', event => {
  const form = event.target.closest('[data-photo]');
  if (!form) return;
  event.preventDefault();
  const patient = activePatient;
  perform(form.querySelector('button'), async () => {
    const file = form.elements.photo.files[0];
    if (!file) return;
    const jpeg = await resizeMedicationPhoto(file);
    if (patient !== activePatient) return;
    await api('medications/' + form.dataset.photo + '/photo', 'POST', { jpeg });
    clearPhotos();
    await refresh();
    notice('Medication photo saved.');
  });
});

byId('patient-access').addEventListener('click', event => {
  const patient = event.target.closest('[data-patient]');
  if (!patient) return;
  selectPatient(patient.dataset.patient);
  if (patient.dataset.destination) activeView = patient.dataset.destination;
  refresh().catch(error => notice(error.message, true));
});
byId('back-patients').addEventListener('click', () => {
  selectPatient('');
  refresh().catch(error => notice(error.message, true));
});
byId('invitations-list').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  perform(event.submitter, async () => {
    const decision = event.submitter.value;
    await api('invitations/' + form.dataset.invite, 'POST', { ...formValues(form), decision });
    await refresh();
    notice(decision === 'accept' ? 'Invitation accepted. The patient is now in your list.' : 'Invitation declined.');
  });
});
byId('refill-cards').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  perform(form.querySelector('button.primary'), async () => {
    await api('refills/' + form.dataset.refill, 'POST', formValues(form));
    await refresh();
    notice('Dose count saved.');
  });
});
byId('edit-handoff').addEventListener('click', () => {
  editingHandoff = true;
  renderHandoff();
  byId('handoff-primary').focus();
});
byId('cancel-handoff').addEventListener('click', () => {
  editingHandoff = false;
  delete byId('handoff-form').dataset.version;
  renderHandoff();
  byId('edit-handoff').focus();
});
byId('handoff-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  perform(form.querySelector('button.primary'), async () => {
    await api('handoff', 'POST', formValues(form));
    editingHandoff = false;
    await refresh();
    if (!byId('handoff-saved').hidden) byId('edit-handoff').focus();
    notice('Handoff rule saved.');
  });
});
byId('disable-handoff').addEventListener('click', event => perform(event.currentTarget, async () => {
  await api('handoff', 'DELETE');
  await refresh();
  if (!byId('handoff-form').hidden) byId('handoff-primary').focus();
  notice('Handoff escalation disabled.');
}));
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
    if (values.due) values.due = Date.parse(values.due + '+05:30');
    const mode = form.dataset.mode || 'accept';
    await api('appointment-requests/' + form.dataset.request + '/' + mode, 'POST', values);
    await refresh();
    notice({ accept: 'Appointment scheduled.', propose: 'Alternate time sent to your doctor.', questions: 'Questions saved.', summary: 'Visit summary posted.' }[mode]);
  });
});
function resetInviteReview() {
  reviewedInvite = '';
  byId('invite-preview').hidden = true;
  byId('invite-preview').textContent = '';
  byId('invite-relationship').hidden = true;
  byId('join-form').elements.relationship.required = false;
  byId('join-form').elements.relationship.value = '';
  byId('review-invite').textContent = tr('Review invitation');
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
      byId('invite-preview').textContent = tr('Invitation from') + ' ' + result.name;
      byId('invite-preview').hidden = false;
      byId('invite-relationship').hidden = false;
      form.elements.relationship.required = true;
      byId('review-invite').textContent = tr('Accept invitation');
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
    const heading = byId(control.dataset.view).querySelector('h1');
    heading.tabIndex = -1;
    heading.focus();
  }
  const { action, id } = control.dataset;
  if (!action) return;
  if (action === 'change-visit') {
    openChangeForm(state.appointments.find(visit => visit.id === id));
    return;
  }
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
    renderFormButton(form);
    form.elements.name.focus();
    return;
  }
  perform(control, async () => {
    if (action.startsWith('delete-')) {
      const entity = action.slice(7);
      if (!window.confirm(tr(entity === 'medications' ? 'Retire this medication schedule?' : 'Remove this entry?'))) return;
      await api(entity + '/' + id, 'DELETE');
      const [formId] = Object.entries(forms).find(([, [key]]) => key === entity);
      if (byId(formId).dataset.edit === id) cancelEdit(byId(formId));
    } else if (action === 'revoke') {
      if (!window.confirm(tr('Revoke this person’s profile access?'))) return;
      await api('contacts/' + id + '/revoke', 'POST');
    } else if (action === 'request-checkin') {
      await api('checkins', 'POST');
    } else if (action === 'disable-refill') {
      await api('refills/' + id, 'DELETE');
    } else if (action === 'remove-photo') {
      await api('medications/' + id + '/photo', 'DELETE');
      clearPhotos();
    } else if (action.startsWith('checkin-')) {
      await api('checkins/' + id + '/' + action.slice(8), 'POST');
    } else if (action.endsWith('-request')) {
      await api('appointment-requests/' + id + '/' + action.split('-')[0], 'POST');
    } else if (action.endsWith('-proposal')) {
      const [request, proposed] = id.split('|');
      await api('appointment-requests/' + request + '/' + action, 'POST', { proposed: Number(proposed) });
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
      'disable-refill': 'Refill tracking disabled.',
      'remove-photo': 'Medication photo removed.',
      'cancel-request': 'Appointment request cancelled.',
      'decline-request': 'Appointment request declined.',
      'accept-proposal': 'Alternate appointment time accepted.',
      'decline-proposal': 'Alternate time declined. The scheduled time remains.',
      revoke: 'Access revoked.'
    };
    notice(messages[action] || 'Entry removed.');
  });
});

initPreferences(() => {
  notice(noticeMessage, byId('notice').hasAttribute('data-error'));
  for (const id of Object.keys(forms)) renderFormButton(byId(id));
  byId('review-invite').textContent = tr(reviewedInvite ? 'Accept invitation' : 'Review invitation');
  byId('access-nav').textContent = byId('access-heading').textContent = tr(careTeam ? 'Care Circle' : 'People & access');
  stopReading();
  byId('read-today').textContent = tr('Read today aloud');
  byId('sound').textContent = tr(armed ? 'Alarm sound on' : 'Enable alarm sound');
  if (state) render();
  if (!byId('logout').hidden) sync();
});
byId('read-today').textContent = tr('Read today aloud');
byId('sound').textContent = tr('Enable alarm sound');
const sync = () => {
  if (!pendingRefreshes) refresh().catch(error => { if (state) notice(error.message, true); });
};
byId('print-report').addEventListener('click', () => window.print());
setInterval(() => { if (state && !document.hidden && now() >= nextTodayUpdate) renderToday(); }, 1000);
setInterval(() => { if (!byId('logout').hidden && !document.hidden) sync(); }, 8000);
document.addEventListener('visibilitychange', () => { if (!byId('logout').hidden && !document.hidden) sync(); });
window.addEventListener('pagehide', () => { stopReading(); stopAlarm(); });
refresh().catch(error => {
  if (byId('auth').hidden) {
    auth();
    notice(error.message, true);
  }
});
