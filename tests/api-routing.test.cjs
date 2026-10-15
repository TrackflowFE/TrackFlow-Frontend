const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const URLS = {
  apiBaseUrl: 'https://original.example/',
  shipmentsApiBaseUrl: 'https://shipments.example/',
  logisticsApiBaseUrl: 'https://logistics.example/',
  reportsApiBaseUrl: 'https://reports.example/'
};

function component(props) {
  const requests = [];
  class DCLogic {
    constructor(props) { this.props = props; }
    setState(update) { Object.assign(this.state, update); }
  }
  const context = vm.createContext({
    DCLogic, React: { createRef: () => ({ current: null }) },
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  vm.runInContext(source + '\nthis.TestComponent = Component;', context);
  return { app: new context.TestComponent(props), requests };
}

test('each route goes to the API that owns it', () => {
  const { app } = component(URLS);
  const esperado = {
    'https://shipments.example': ['/api/auth/login', '/api/auth/sesion', '/api/auth/logout',
      '/api/cities?q=ma&onlyCovered=true', '/api/shipments'],
    'https://logistics.example': ['/api/shipments/TF123/events', '/api/shipments/TF123/route',
      '/api/shipments/TF123/actions', '/api/centers'],
    'https://reports.example': ['/api/tracking/TF123', '/api/reports/delayed-shipments',
      '/api/reports/transit-times?from=2026-10-01&to=2026-10-02', '/api/reports/shipment-volume'],
    'https://original.example': ['/api/admin/rebuild-projections']
  };
  for (const [base, rutas] of Object.entries(esperado)) {
    for (const ruta of rutas) assert.equal(app.apiBaseFor(ruta), base, ruta);
  }
});

test('with no API URL configured everything keeps using the monolith', () => {
  for (const vacia of ['', '   ', undefined]) {
    const { app } = component({ apiBaseUrl: 'https://original.example', shipmentsApiBaseUrl: vacia,
      logisticsApiBaseUrl: vacia, reportsApiBaseUrl: vacia });
    for (const ruta of ['/api/auth/login', '/api/cities?q=a', '/api/shipments', '/api/shipments/TF1/events',
      '/api/shipments/TF1/actions', '/api/centers', '/api/tracking/TF1', '/api/reports/shipment-volume']) {
      assert.equal(app.apiBaseFor(ruta), 'https://original.example', ruta);
    }
  }
});

test('a protected logistics call renews the session in API 1 and passes the same JWT', async () => {
  const { app, requests } = component(URLS);
  app.state.token = 'shared-jwt';
  await app.api('/api/shipments/TF123/actions');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://shipments.example/api/auth/sesion');
  assert.equal(requests[1].url, 'https://logistics.example/api/shipments/TF123/actions');
  for (const request of requests) assert.equal(request.options.headers.Authorization, 'Bearer shared-jwt');
});

test('posting a logistics event renews the session and then goes to API 3', async () => {
  const { app, requests } = component(URLS);
  app.state.token = 'shared-jwt';
  await app.api('/api/shipments/TF123/events', { method: 'POST', body: { type: 'DISPATCHED' }, idempotencia: 'clave-1' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://shipments.example/api/auth/sesion');
  assert.equal(requests[1].url, 'https://logistics.example/api/shipments/TF123/events');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers['Idempotency-Key'], 'clave-1');
});

test('public logistics reads use API 3 without a token and without renewing the session', async () => {
  const { app, requests } = component(URLS);
  app.state.token = 'shared-jwt';
  await app.api('/api/shipments/TF123/events', { publico: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://logistics.example/api/shipments/TF123/events');
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test('registration and login go straight to API 1 without renewing anything', async () => {
  const { app, requests } = component(URLS);
  app.state.token = 'shared-jwt';
  await app.api('/api/shipments', { method: 'POST', body: {} });
  await app.api('/api/auth/login', { method: 'POST', body: {}, publico: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://shipments.example/api/shipments');
  assert.equal(requests[1].url, 'https://shipments.example/api/auth/login');
});
