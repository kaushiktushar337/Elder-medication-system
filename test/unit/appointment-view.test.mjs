import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAppointments, todayAppointment } from '../../public/js/appointments.js';

test('appointment views preserve role controls and escape patient-entered text', t => {
  const fields = new Map();
  const document = { getElementById(id) {
    if (!fields.has(id)) fields.set(id, {});
    return fields.get(id);
  } };
  globalThis.document = document;
  t.after(() => { delete globalThis.document; });
  const markup = new Map();
  const show = (id, html) => markup.set(id, html);
  const current = Date.parse('2026-11-15T08:00:00+05:30');
  const visit = { id: 'visit', doctor: 'assigned', due: current + 3600000, name: '<care note>' };
  const state = {
    start: Date.parse('2026-11-15T00:00:00+05:30'),
    appointments: [visit],
    requests: [],
    doctors: [],
    me: { id: 'assigned', relationship: 'Doctor' }
  };
  assert.equal(todayAppointment(state, current), visit);
  renderAppointments(state, current, show);
  assert.match(markup.get('appointment-list'), /&lt;care note&gt;/);
  assert.match(markup.get('appointment-list'), /data-action="edit-appointments"/);

  state.me = { id: 'another', relationship: 'Doctor' };
  renderAppointments(state, current, show);
  assert.doesNotMatch(markup.get('appointment-list'), /data-action="edit-appointments"/);

  state.me = { owner: true };
  renderAppointments(state, current, show);
  assert.match(markup.get('appointment-list'), /data-action="change-visit"/);
});
