const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

function component(props, responses = []) {
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
      return responses.shift() || { ok: true, status: 200, json: async () => ({}) };
    }
  });
  vm.runInContext(source + '\nthis.TestComponent = Component;', context);
  return { app: new context.TestComponent(props), requests };
}

test('API 2 owns tracking and reports, not registration, auth or logistics', () => {
  const { app } = component({ apiBaseUrl: 'https://original.example/', reportsApiBaseUrl: 'https://reports.example/' });
  for (const route of ['/api/tracking/TF123', '/api/reports/transit-times?from=2026-10-01',
    '/api/reports/shipment-volume', '/api/reports/delayed-shipments']) {
    assert.equal(app.apiBaseFor(route), 'https://reports.example');
  }
  for (const route of ['/api/auth/login', '/api/auth/sesion', '/api/auth/logout', '/api/shipments',
    '/api/shipments/TF123/events', '/api/shipments/TF123/route', '/api/centers', '/api/cities']) {
    assert.equal(app.apiBaseFor(route), 'https://original.example');
  }
});

test('empty API 2 URL retains the explicitly required monolith backup', () => {
  for (const reportsApiBaseUrl of ['', '   ', undefined]) {
    const { app } = component({ apiBaseUrl: 'https://original.example', reportsApiBaseUrl });
    assert.equal(app.apiBaseFor('/api/tracking/TF123'), 'https://original.example');
  }
});

test('public tracking uses API 2 without transmitting a token', async () => {
  const { app, requests } = component({ apiBaseUrl: 'https://original.example', reportsApiBaseUrl: 'https://reports.example' });
  app.state.token = 'shared-jwt';
  await app.api('/api/tracking/TF123', { publico: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://reports.example/api/tracking/TF123');
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test('protected reports renew session in API 1 and pass the same JWT to API 2', async () => {
  const { app, requests } = component({ apiBaseUrl: 'https://original.example', reportsApiBaseUrl: 'https://reports.example' });
  app.state.token = 'shared-jwt';
  await app.api('/api/reports/delayed-shipments');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://original.example/api/auth/sesion');
  assert.equal(requests[1].url, 'https://reports.example/api/reports/delayed-shipments');
  for (const request of requests) assert.equal(request.options.headers.Authorization, 'Bearer shared-jwt');
});

test('failed session verification stops the report request', async () => {
  const { app, requests } = component({ apiBaseUrl: 'https://original.example', reportsApiBaseUrl: 'https://reports.example' },
    [{ ok: false, status: 401, json: async () => ({}) }]);
  app.state.token = 'closed-jwt';
  const result = await app.api('/api/reports/shipment-volume');
  assert.equal(result.status, 401);
  assert.equal(requests.length, 1);
  assert.equal(app.state.token, null);
  assert.equal(app.state.route, 'login');
});
