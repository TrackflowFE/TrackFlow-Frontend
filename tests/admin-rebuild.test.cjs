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
  logisticsApiBaseUrl: 'https://logistics.example/'
};

// El objeto nace en el contexto aislado de la prueba, así que se compara por contenido.
function plano(valor) { return JSON.parse(JSON.stringify(valor)); }

function respuesta(status, cuerpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => cuerpo };
}

function component(props, respuestas = []) {
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
      return respuestas.shift() || respuesta(200, {});
    }
  });
  vm.runInContext(source + '\nthis.TestComponent = Component;', context);
  return { app: new context.TestComponent(props), requests };
}

test('rebuild calls API 1 first and then API 3, and joins both results', async () => {
  const { app, requests } = component(URLS, [
    respuesta(200, { shipmentsRepublished: 3 }),
    respuesta(200, {}),
    respuesta(200, { eventsRepublished: 7 })
  ]);
  app.state.token = 'admin-jwt';
  await app.rebuild();
  assert.equal(requests[0].url, 'https://shipments.example/api/admin/rebuild-projections');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[1].url, 'https://shipments.example/api/auth/sesion');
  assert.equal(requests[2].url, 'https://logistics.example/api/admin/rebuild-projections');
  for (const request of requests) assert.equal(request.options.headers.Authorization, 'Bearer admin-jwt');
  assert.deepEqual(plano(app.state.adminResult), { shipmentsRepublished: 3, eventsRepublished: 7 });
  assert.equal(app.state.adminLoading, false);
});

test('if API 1 fails, API 3 is not called and the error is shown', async () => {
  const { app, requests } = component(URLS, [respuesta(500, { detail: 'falló la republicación' })]);
  app.state.token = 'admin-jwt';
  await app.rebuild();
  assert.equal(requests.length, 1);
  assert.equal(app.state.adminError, 'falló la republicación');
  assert.equal(app.state.adminResult, null);
});

test('with a missing API URL the monolith does both jobs in a single call', async () => {
  for (const props of [
    { apiBaseUrl: 'https://original.example' },
    { apiBaseUrl: 'https://original.example', shipmentsApiBaseUrl: 'https://shipments.example' },
    { apiBaseUrl: 'https://original.example', logisticsApiBaseUrl: 'https://logistics.example' }
  ]) {
    const { app, requests } = component(props, [respuesta(200, { shipmentsRepublished: 1, eventsRepublished: 2 })]);
    app.state.token = 'admin-jwt';
    await app.rebuild();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://original.example/api/admin/rebuild-projections');
    assert.deepEqual(plano(app.state.adminResult), { shipmentsRepublished: 1, eventsRepublished: 2 });
  }
});
