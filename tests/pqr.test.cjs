const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const XSS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>'];

function setup() {
  class DCLogic {
    constructor(props) { this.props = props; }
    setState(update) { Object.assign(this.state, typeof update === 'function' ? update(this.state) : update); }
  }
  class FormData { constructor(form) { this.form = form; } get(key) { return this.form[key] || null; } }
  const context = vm.createContext({ DCLogic, React: { createRef: () => ({ current: null }) }, FormData, AbortController, setTimeout, clearTimeout, window: { confirm: () => true } });
  vm.runInContext(source + '\nthis.TestComponent = Component;', context);
  const app = new context.TestComponent({});
  const calls = [];
  app.api = async (ruta, opts) => { calls.push({ ruta, opts }); return app.respuesta || { ok: true, status: 200, data: {} }; };
  return { app, calls };
}

const valido = { tipo: 'RECLAMO', descripcion: 'Mi paquete llegó con la caja rota y mojada.', contactoNombre: 'Ana Pérez', contactoEmail: 'ana@correo.com',
  contactoTelefono: '300 123 4567', numeroSeguimiento: 'tfa1b2c3d4e5f6', aceptaTratamientoDatos: 'on' };
const plano = (x) => JSON.parse(JSON.stringify(x));
const enviar = (form) => ({ preventDefault() {}, target: form });

test('PQR, consulta y chatbot van a la API 1', () => {
  const { app } = setup();
  app.props = { apiBaseUrl: 'https://original.example', shipmentsApiBaseUrl: 'https://shipments.example' };
  for (const ruta of ['/api/pqr', '/api/pqr/consulta', '/api/pqr?size=50&estado=RECIBIDA', '/api/pqr/PQR-2026-00001', '/api/pqr/PQR-2026-00001/estado', '/api/chatbot/mensajes']) {
    assert.equal(app.apiBaseFor(ruta), 'https://shipments.example', ruta);
  }
});

test('radicar envía el contrato, sin token, y muestra el radicado', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt';
  app.respuesta = { ok: true, status: 201, data: { radicado: 'PQR-2026-00042', estado: 'RECIBIDA', tipo: 'RECLAMO', mensaje: 'Recibimos tu PQR.' } };
  await app.submitPqr(enviar(valido));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ruta, '/api/pqr');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.publico, true);
  assert.deepEqual(plano(calls[0].opts.body), { tipo: 'RECLAMO', descripcion: valido.descripcion, contactoNombre: 'Ana Pérez', contactoEmail: 'ana@correo.com',
    contactoTelefono: '300 123 4567', numeroSeguimiento: 'TFA1B2C3D4E5F6', aceptaTratamientoDatos: true });
  const v = app.renderVals();
  assert.equal(v.pqrCreated, true);
  assert.equal(v.pqrRadicado, 'PQR-2026-00042');
  assert.equal(v.pqrCreatedEstado, 'Recibida');
  assert.equal(v.pqrMostrarForm, false);
});

test('radicar valida en el navegador antes de llamar a la API', async () => {
  const casos = [
    [{ tipo: '' }, /tipo/], [{ descripcion: 'muy corta' }, /20 y 2000/], [{ descripcion: 'x'.repeat(2001) }, /20 y 2000/],
    [{ contactoNombre: 'A' }, /nombre/], [{ contactoEmail: 'sin-arroba' }, /correo/], [{ contactoTelefono: 'abc' }, /teléfono/],
    [{ numeroSeguimiento: 'XX123' }, /guía/], [{ aceptaTratamientoDatos: '' }, /aceptar/]
  ];
  for (const [cambio, patron] of casos) {
    const { app, calls } = setup();
    await app.submitPqr(enviar({ ...valido, ...cambio }));
    assert.equal(calls.length, 0, JSON.stringify(cambio));
    assert.match(app.state.pqrError, patron);
  }
});

test('radicar: 429 explica la espera y un fallo de red avisa que pudo registrarse', async () => {
  const { app } = setup();
  app.respuesta = { ok: false, status: 429, data: null, retryAfter: '600' };
  await app.submitPqr(enviar(valido));
  assert.match(app.state.pqrError, /Espera 10 minutos/);
  assert.equal(app.state.pqrBusy, false);
  app.api = async () => { throw new Error('Failed to fetch'); };
  await app.submitPqr(enviar(valido));
  assert.match(app.state.pqrError, /podría haberse registrado/);
});

test('consultar usa radicado en mayúsculas + correo y nunca el token', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt';
  app.respuesta = { ok: true, status: 200, data: { radicado: 'PQR-2026-00042', tipo: 'QUEJA', estado: 'RESUELTA', fechaRadicacion: '2026-11-01T10:00:00Z',
    fechaActualizacion: '2026-11-02T10:00:00Z', respuesta: 'Ya lo resolvimos.', historial: [{ estado: 'RECIBIDA', fecha: '2026-11-01T10:00:00Z' }] } };
  await app.consultarPqr(enviar({ radicado: ' pqr-2026-00042 ', email: 'ana@correo.com' }));
  assert.deepEqual(plano(calls[0].opts.body), { radicado: 'PQR-2026-00042', email: 'ana@correo.com' });
  assert.equal(calls[0].opts.publico, true);
  const v = app.renderVals();
  assert.equal(v.prEstado, 'Resuelta');
  assert.equal(v.prTieneRespuesta, true);
  assert.equal(v.prHistorial.length, 1);
  app.respuesta = { ok: false, status: 404, data: null };
  await app.consultarPqr(enviar({ radicado: 'PQR-1', email: 'otra@correo.com' }));
  assert.match(app.state.pqrError, /No encontramos una PQR con esos datos/);
  assert.equal(app.state.pqrResultado, null);
});

test('texto malicioso llega como texto plano y las vistas no usan HTML crudo', () => {
  const { app } = setup();
  for (const carga of XSS) {
    app.state.pqrDetalle = { radicado: 'PQR-2026-00001', tipo: 'QUEJA', estado: 'RECIBIDA', descripcion: carga, contactoNombre: carga, contactoEmail: 'a@b.co',
      respuesta: carga, respondidoPor: carga, fechaRadicacion: '2026-11-01T10:00:00Z', historial: [] };
    app.state.pqrResultado = { radicado: 'PQR-2026-00001', tipo: 'QUEJA', estado: 'RESUELTA', respuesta: carga, historial: [] };
    const v = app.renderVals();
    assert.equal(v.pdqDescripcion, carga);
    assert.equal(v.pdqNombre, carga);
    assert.equal(v.prRespuesta, carga);
  }
  const vistas = html.slice(html.indexOf('PQR (HU-19)'), html.indexOf('USUARIOS, ROLES Y PERMISOS (HU-11)'));
  assert.ok(vistas.length > 1000);
  assert.doesNotMatch(vistas, /innerHTML|dangerouslySetInnerHTML|<sc-html|unsafe/i);
  assert.match(vistas, /white-space:pre-wrap[^>]*>\{\{ pdqDescripcion \}\}/);
  assert.match(vistas, /white-space:pre-wrap[^>]*>\{\{ prRespuesta \}\}/);
});

test('la bandeja pide la lista, abre el detalle y valida el cambio de estado', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt'; app.state.roles = 'SUPERVISOR';
  assert.equal(app.renderVals().puedeAtenderPqr, true);
  app.respuesta = { ok: true, status: 200, data: [{ radicado: 'PQR-2026-00001', tipo: 'QUEJA', estado: 'RECIBIDA', contactoNombre: 'Ana', fechaRadicacion: '2026-11-01T10:00:00Z' }] };
  app.goPqrGestion(); await new Promise(r => setImmediate(r));
  assert.equal(calls[0].ruta, '/api/pqr?size=50');
  assert.equal(app.renderVals().pqrFilas.length, 1);
  assert.match(app.renderVals().pqrFilas[0].label, /PQR-2026-00001 · Queja · Recibida · Ana/);
  app.state.pqrDetalle = { radicado: 'PQR-2026-00001', estado: 'EN_TRAMITE', tipo: 'QUEJA', descripcion: 'd', historial: [] };
  assert.deepEqual(plano(app.renderVals().pdqSiguientes.map(o => o.valor)), ['RESUELTA']);
  const n = calls.length;
  await app.cambiarEstadoPqr(enviar({ estado: 'RESUELTA', respuesta: 'corta' }));
  await app.cambiarEstadoPqr(enviar({ estado: 'CERRADA', respuesta: '' }));
  assert.equal(calls.length, n);
  app.respuesta = { ok: true, status: 200, data: { ...app.state.pqrDetalle, estado: 'RESUELTA' } };
  await app.cambiarEstadoPqr(enviar({ estado: 'RESUELTA', respuesta: 'Reponemos el paquete.' }));
  const post = calls.find(c => c.opts && c.opts.method === 'POST');
  assert.equal(post.ruta, '/api/pqr/PQR-2026-00001/estado');
  assert.deepEqual(plano(post.opts.body), { estado: 'RESUELTA', respuesta: 'Reponemos el paquete.' });
  assert.match(app.state.pqrNotice, /Estado actualizado/);
});

test('sin rol de supervisor no aparece "Atender PQR"; salir de las pantallas limpia el caso', () => {
  const { app } = setup();
  app.state.token = 'jwt'; app.state.roles = 'OPERADOR';
  assert.equal(app.renderVals().puedeAtenderPqr, false);
  app.state.route = 'pqr-gestion'; app.state.pqrDetalle = { radicado: 'X' }; app.state.pqrLista = [{}];
  const antes = app._pqrSession || 0;
  app.setState({ route: 'home' });
  assert.equal(app.state.pqrDetalle, null);
  assert.deepEqual(plano(app.state.pqrLista), []);
  assert.equal(app._pqrSession, antes + 1);
});
