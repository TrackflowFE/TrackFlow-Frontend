const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

function setup() {
  class DCLogic {
    constructor(props) { this.props = props; }
    setState(update, cb) {
      Object.assign(this.state, typeof update === 'function' ? update(this.state) : update);
      if (cb) cb();
    }
  }
  const context = vm.createContext({
    DCLogic, React: { createRef: () => ({ current: null }) },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(source + '\nthis.TestComponent = Component;', context);
  return new context.TestComponent({ apiBaseUrl: 'https://api.example' });
}

test('el anónimo consulta el rastreo sin token y ve la nota de privacidad', async () => {
  const app = setup();
  app.state.token = null;
  const llamadas = [];
  app.api = async (ruta, opts) => {
    llamadas.push({ ruta, opts });
    if (ruta.includes('/events')) return { ok: true, status: 200, data: { movements: [] } };
    if (ruta.includes('/route')) return { ok: true, status: 200, data: { stops: [] } };
    return { ok: true, status: 200, data: {
      trackingNumber: 'TF0123456789AB', status: 'DELIVERED', senderName: 'L*** G***',
      recipientName: 'A*** T***', destinationCity: 'Medellin', restricted: true
    } };
  };

  await app.fetchTracking('TF0123456789AB');

  assert.equal(llamadas[0].opts.publico, true);
  assert.equal(app.renderVals().t_restricted, true);
  assert.equal(app.renderVals().t_remitente, 'L*** G***');
});

test('el operador consulta el rastreo con token', async () => {
  const app = setup();
  app.state.token = 'jwt-operador';
  const llamadas = [];
  app.api = async (ruta, opts) => {
    llamadas.push({ ruta, opts });
    if (ruta.includes('/events')) return { ok: true, status: 200, data: { movements: [] } };
    if (ruta.includes('/route')) return { ok: true, status: 200, data: { stops: [] } };
    return { ok: true, status: 200, data: { trackingNumber: 'TF0123456789AB', status: 'IN_TRANSIT', restricted: false } };
  };

  await app.fetchTracking('TF0123456789AB');

  assert.equal(llamadas[0].opts.publico, false);
  assert.equal(app.renderVals().t_restricted, false);
});

test('sin dirección, un envío entregado muestra la ciudad', () => {
  const app = setup();
  app.state.tracking = { trackingNumber: 'TF0123456789AB', status: 'DELIVERED', destinationCity: 'Medellin' };

  assert.equal(app.renderVals().t_ubicLabel, 'Entregado en');
  assert.equal(app.renderVals().t_ultimoPunto, 'Medellin');
  assert.equal(app.renderVals().t_ubicSub, '');
});

test('un 429 del rastreo muestra el tiempo de espera', async () => {
  const app = setup();
  app.api = async () => ({ ok: false, status: 429, retryAfter: '30', data: {} });

  await app.fetchTracking('TF0123456789AB');

  assert.equal(app.state.netError, 'Demasiadas consultas; espera 30 segundos.');
});
