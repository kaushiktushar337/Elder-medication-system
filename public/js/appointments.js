import { tr } from './language.js';
import { button, controls, dayTime, empty, row, safe } from './view-helpers.js';

export function todayAppointment(state, current) {
  const upcoming = state.appointments.find(item => item.due > current);
  return upcoming?.due < state.start + 86_400_000 ? upcoming : null;
}

function visitForm(item, action, fields, label) {
  return '<form class="visit-form" data-request="' + safe(item.id) + '" data-mode="' + action + '">' + fields + '<button class="primary">' + safe(tr(label)) + '</button></form>';
}

function visitDetails(item, me, current) {
  const patient = me.owner;
  const doctor = me.relationship === 'Doctor';
  const future = item.status === 'scheduled' && item.due > current;
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

export function renderAppointments(state, current, show) {
  const byId = id => document.getElementById(id);
  const canRequest = state.me.canRequestAppointment ?? state.me.owner;
  byId('appointment-form').hidden = state.me.relationship !== 'Doctor';
  byId('request-appointment-form').hidden = !canRequest || !state.doctors.length;
  byId('no-linked-doctors').hidden = !canRequest || Boolean(state.doctors.length);
  byId('no-linked-doctors').textContent = tr(state.me.owner ? 'Invite your doctor from People & access before requesting an appointment.' : 'Ask the patient to link their doctor before requesting an appointment.');
  show('doctor-picker', '<option value="">' + safe(tr('Choose doctor')) + '</option>' + state.doctors.map(doctor => '<option value="' + safe(doctor.id) + '">' + safe(doctor.name) + '</option>').join(''));
  const todayVisit = todayAppointment(state, current);
  const awaitingChange = todayVisit && state.requests.find(item => item.id === todayVisit.id && item.proposal_state === 'pending');
  let todayStatus = '';
  if (state.me.owner && awaitingChange) {
    todayStatus = empty(tr('Change requested') + ' · ' + dayTime(awaitingChange.proposed_due));
  } else if (state.me.owner && !todayVisit) {
    todayStatus = state.requests.filter(item => item.status === 'pending').slice(0, 2)
      .map(item => empty(item.name + ' · ' + tr('Awaiting response') + ' · ' + item.doctor_name)).join('');
  }
  show('today-request-status', todayStatus);
  show('appointment-requests', state.requests.map(item => {
    const description = item.doctor_name + ' · ' + (item.status === 'scheduled' ? tr('Scheduled') + ' · ' + dayTime(item.due) + (item.location ? ' · ' + item.location : '') : tr(item.status === 'pending' ? 'Awaiting response' : item.status));
    let actions = item.status === 'pending' && state.me.owner ? button('cancel-request', item.id, 'Cancel request') : '';
    if (item.status === 'pending' && state.me.relationship === 'Doctor') actions = '<form class="request-response" data-request="' + safe(item.id) + '"><label>' + safe(tr('Appointment time (IST)')) + '<input name="due" type="datetime-local" required></label><label>' + safe(tr('Location')) + '<input name="location" maxlength="100"></label><button class="primary">' + safe(tr('Accept and schedule')) + '</button></form>' + button('decline-request', item.id, 'Decline');
    return '<article class="visit-entry">' + row(item.name, description, actions) + visitDetails(item, state.me, current) + '</article>';
  }).join(''));
  const requestIds = new Set(state.requests.map(request => request.id));
  const standalone = state.appointments.filter(item => !requestIds.has(item.id));
  const visits = standalone.map(item => {
    const detail = [tr('Scheduled'), dayTime(item.due), item.location].filter(Boolean).join(' · ');
    const canEdit = state.me.relationship === 'Doctor' && !item.status && (!item.doctor || item.doctor === state.me.id);
    let actions = '';
    if (canEdit) actions = controls('appointments', item);
    else if (state.me.owner && item.due > current) actions = button('change-visit', item.id, 'Request a change');
    return row(item.name, detail, actions);
  }).join('');
  show('appointment-list', visits || (state.requests.length ? '' : empty(tr('No appointments scheduled.'))));
}
