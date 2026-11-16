const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const hours = { days: [1, 2, 3, 4, 5, 6], slots: ['08:00-10:00', '12:00-14:00', '16:00-18:00'], leadTimeHours: 4, horizonDays: 30, timeZone: 'America/Bogota' };

function setup() {
  class DCLogic {
    constructor(props) { this.props = props; }
    setState(update) { Object.assign(this.state, typeof update === 'function' ? update(this.state) : update); }
  }
  class FormData { constructor(form) { this.form = form; } get(key) { return this.form[key] || null; } }
  const context = vm.createContext({ DCLogic, React: { createRef: () => ({ current: null }) }, FormData, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source + '\nthis.TestComponent = Component; this.validate = validarHorarioRecogida;', context);
  const app = new context.TestComponent({});
  return { app, validate: context.validate };
}

test('validates configured days, horizon, slot and Bogota lead time', () => {
  const { validate } = setup();
  const now = new Date('2026-11-16T13:00:00Z');
  assert.equal(validate('2026-11-16', '12:00-14:00', hours, now), '');
  assert.match(validate('2026-11-16', '08:00-10:00', hours, now), /tiempo suficiente/);
  assert.match(validate('2026-11-15', '08:00-10:00', hours, now), /pasó/);
  assert.match(validate('2026-11-22', '08:00-10:00', hours, now), /No se recoge/);
  assert.match(validate('2026-12-17', '08:00-10:00', hours, now), /horizonte/);
  assert.match(validate('2026-11-17', '10:00-12:00', hours, now), /franja/);
  assert.match(validate('2026-02-30', '08:00-10:00', hours, now), /fecha válida/);
  assert.match(validate('2026-11-16', '12:00-14:00', hours, new Date('2026-11-16T13:00:00.001Z')), /tiempo suficiente/);
});

test('submits the API creation contract and normalizes optional tracking', async () => {
  const { app } = setup();
  const tomorrow = new Date(Date.now() + 86400000 * 2);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  app.state.pickupHours = { ...hours, days: [1, 2, 3, 4, 5, 6, 7] };
  app.state.pickupCityId = 3;
  let sent;
  app.api = async (url, options) => { sent = { url, options }; return { ok: true, status: 202, data: { pickupNumber: 'RC123456789012', status: 'REQUESTED' } }; };
  await app.submitPickup({ preventDefault() {}, target: { address: 'Calle 123', contactName: 'Ana Torres', contactPhone: '3001234567', scheduledDate: date, timeSlot: '08:00-10:00', packageSize: 'MEDIUM', weightKg: '5.5', shipmentTrackingNumber: 'tf0123456789ab' } });
  assert.equal(sent.url, '/api/pickups');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.options.body)), { address: 'Calle 123', cityId: 3, contactName: 'Ana Torres', contactPhone: '3001234567', scheduledDate: date, timeSlot: '08:00-10:00', packageSize: 'MEDIUM', weightKg: 5.5, shipmentTrackingNumber: 'TF0123456789AB' });
  assert.equal(app.state.pickupCreated.pickupNumber, 'RC123456789012');
});

test('labels all states and suppresses private fields for restricted details', () => {
  const { app } = setup();
  for (const [status, label] of Object.entries({ REQUESTED: 'Solicitada', SCHEDULED: 'Programada', ON_THE_WAY: 'En camino', PICKED_UP: 'Recogida', CANCELLED: 'Cancelada' })) {
    app.state.pickupDetail = { pickupNumber: 'RC123456789012', status, accessRestricted: true, address: 'secret', contactName: 'secret', contactPhone: 'secret', history: [{ type: 'CANCELLED', detail: 'secret' }] };
    const view = app.renderVals();
    assert.equal(view.pdStatus, label);
    assert.equal(view.pdRestricted, true);
    assert.equal(view.pdVisible, false);
    assert.equal(view.pdAddress, '');
    assert.equal(view.pdContact, '');
    assert.equal(view.pdPhone, '');
    assert.doesNotMatch(view.pdHistory[0].label, /secret/);
  }
  assert.match(html, /Dirección y contacto no visibles para su usuario/);
});

test('custody step appears only when custody is present in status or movements', () => {
  const { app } = setup();
  app.state.tracking = { status: 'AT_DISTRIBUTION_CENTER' };
  assert.equal(app.renderVals().pasos.length, 6);
  app.state.events = [{ type: 'PICKED_UP', occurredAt: '2026-11-16T13:00:00Z' }];
  assert.equal(app.renderVals().pasos.length, 7);
  app.state.events = [];
  app.state.tracking.status = 'IN_CUSTODY';
  assert.equal(app.renderVals().t_estado, 'En custodia');
  assert.equal(app.renderVals().pasos.length, 7);
});

test('schedule sends assignment and successful commands stay pending until refresh', async () => {
  const { app } = setup();
  const future = new Date(Date.now() + 86400000 * 2);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(future);
  app.state.pickupHours = { ...hours, days: [1, 2, 3, 4, 5, 6, 7] };
  app.state.pickupDetail = { pickupNumber: 'RC123456789012', status: 'REQUESTED' };
  let sent;
  app.api = async (url, options) => { sent = { url, options }; return { ok: true, status: 202 }; };
  app.programarPickup({ preventDefault() {}, target: { scheduledDate: date, timeSlot: '08:00-10:00', assignedUsername: 'operador' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.url, '/api/pickups/RC123456789012/schedule');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.options.body)), { scheduledDate: date, timeSlot: '08:00-10:00', assignedUsername: 'operador' });
  assert.equal(app.state.pickupDetail.status, 'REQUESTED');
  assert.match(app.state.pickupNotice, /procesamiento/);
});

test('a late detail response cannot restore private information after logout', async () => {
  const { app } = setup();
  let resolve;
  app.api = () => new Promise(done => { resolve = done; });
  const pending = app.consultarPickup('RC123456789012');
  app.olvidarSesion();
  resolve({ ok: true, data: { address: 'secret', accessRestricted: false } });
  await pending;
  assert.equal(app.state.pickupDetail, null);
});
