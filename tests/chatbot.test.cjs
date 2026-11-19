const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const XSS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>'];
const SESION = '3f1c2a4e-9b7d-4c1a-8e5f-0a1b2c3d4e5f';

function setup() {
  class DCLogic {
    constructor(props) { this.props = props; }
    setState(update, cb) { Object.assign(this.state, typeof update === 'function' ? update(this.state) : update); if (cb) cb(); }
  }
  class FormData { constructor(form) { this.form = form; } get(key) { return this.form[key] || null; } }
  const context = vm.createContext({ DCLogic, React: { createRef: () => ({ current: null }) }, FormData, AbortController, setTimeout, clearTimeout, window: { confirm: () => true } });
  vm.runInContext(source + '\nthis.TestComponent = Component;', context);
  const app = new context.TestComponent({});
  const calls = [];
  app.respuestas = [];
  app.api = async (ruta, opts) => {
    calls.push({ ruta, opts });
    const siguiente = app.respuestas.shift();
    return typeof siguiente === 'function' ? siguiente(ruta, opts) : siguiente || { ok: true, status: 200, data: {} };
  };
  return { app, calls };
}

const plano = (x) => JSON.parse(JSON.stringify(x));
const enviar = (form) => ({ preventDefault() {}, target: form });
const sesion = { ok: true, status: 201, data: { sesionId: SESION } };
const respuesta = (texto, acciones = []) => ({ ok: true, status: 200, data: { resultado: 'RESPUESTA', intencion: 'x', texto, acciones } });

test('el chatbot y su editor van a la API 1', () => {
  const { app } = setup();
  app.props = { apiBaseUrl: 'https://original.example', shipmentsApiBaseUrl: 'https://shipments.example' };
  for (const ruta of ['/api/chatbot/sesiones', '/api/chatbot/mensajes', '/api/chatbot/sugerencias', '/api/admin/chatbot/faq', '/api/admin/chatbot/faq/7/activo']) {
    assert.equal(app.apiBaseFor(ruta), 'https://shipments.example', ruta);
  }
});

test('el primer mensaje abre la sesión y los siguientes la reutilizan, siempre sin token', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt';
  app.respuestas = [sesion, respuesta('Usa Rastrear.', [{ tipo: 'IR_A_CONSULTA', etiqueta: 'Rastrear mi envío' }]), respuesta('Otra respuesta.')];
  await app.enviarChat(enviar({ texto: '  cómo rastreo  ' }));
  await app.enviarChat(enviar({ texto: 'gracias' }));

  assert.deepEqual(calls.map(c => c.ruta), ['/api/chatbot/sesiones', '/api/chatbot/mensajes', '/api/chatbot/mensajes']);
  assert.deepEqual(plano(calls[1].opts.body), { sesionId: SESION, texto: 'cómo rastreo' });
  for (const c of calls) assert.equal(c.opts.publico, true);
  const v = app.renderVals();
  assert.deepEqual(plano(v.chatFilas.map(f => f.texto)), ['cómo rastreo', 'Usa Rastrear.', 'gracias', 'Otra respuesta.']);
  assert.equal(v.chatBusy, false);
});

test('las acciones del chat llevan a la PQR o a Rastrear y cierran el chat', async () => {
  const { app } = setup();
  app.state.chatOpen = true;
  app.respuestas = [sesion, respuesta('Fuera de tema.', [{ tipo: 'ABRIR_PQR', etiqueta: 'Radicar una PQR' }])];
  await app.enviarChat(enviar({ texto: 'quien gano' }));
  const v = app.renderVals();
  assert.equal(v.chatHayAcciones, true);
  assert.equal(v.chatAcciones[0].etiqueta, 'Radicar una PQR');
  v.chatAcciones[0].ir();
  assert.equal(app.state.route, 'pqr');
  assert.equal(app.state.chatOpen, false);

  app.irDesdeChat('IR_A_CONSULTA');
  assert.equal(app.state.route, 'home');
});

test('si la sesión venció se abre otra y se reintenta una sola vez', async () => {
  const { app, calls } = setup();
  app.state.chatSesion = 'vieja';
  app.respuestas = [{ ok: false, status: 400, data: { title: 'Sesión no válida' } }, sesion, respuesta('Listo.')];
  await app.enviarChat(enviar({ texto: 'hola' }));

  assert.deepEqual(calls.map(c => c.ruta), ['/api/chatbot/mensajes', '/api/chatbot/sesiones', '/api/chatbot/mensajes']);
  assert.equal(calls[2].opts.body.sesionId, SESION);
  assert.equal(app.renderVals().chatFilas.length, 2);
  assert.equal(app.state.chatError, '');
});

test('un 429 explica cuánto esperar, conserva la conversación y no pierde lo escrito', async () => {
  const { app } = setup();
  app.state.chatSesion = SESION;
  app.state.chatMsgs = [{ quien: 'yo', texto: 'antes' }, { quien: 'bot', texto: 'respuesta', acciones: [] }];
  const form = { texto: 'otra', reset() { this.limpio = true; } };
  app.respuestas = [{ ok: false, status: 429, data: null, retryAfter: '60' }];
  await app.enviarChat(enviar(form));

  assert.match(app.state.chatError, /muy rápido\. Espera 1 minuto/);
  assert.equal(app.state.chatMsgs.length, 2);
  assert.equal(app.state.chatBusy, false);
  assert.equal(form.limpio, undefined);
});

test('sin conexión muestra el error y deja volver a intentar', async () => {
  const { app } = setup();
  app.state.chatSesion = SESION;
  app.respuestas = [() => { throw new Error('Failed to fetch'); }];
  await app.enviarChat(enviar({ texto: 'hola' }));
  assert.equal(app.state.chatError, 'Failed to fetch');
  assert.equal(app.state.chatBusy, false);
});

test('no llama a la API con mensajes vacíos o demasiado largos', async () => {
  const { app, calls } = setup();
  await app.enviarChat(enviar({ texto: '   ' }));
  await app.enviarChat(enviar({ texto: 'a'.repeat(301) }));
  assert.equal(calls.length, 0);
  assert.match(app.state.chatError, /300 caracteres/);
});

test('las sugerencias se piden al abrir, salen como botones y se envían como mensaje', async () => {
  const { app, calls } = setup();
  app.respuestas = [{ ok: true, status: 200, data: [{ intencion: 'como_rastrear', pregunta: '¿Cómo rastreo mi envío?' }] }, sesion, respuesta('Usa Rastrear.')];
  app.toggleChat();
  await new Promise(r => setImmediate(r));
  assert.equal(calls[0].ruta, '/api/chatbot/sugerencias');
  assert.equal(app.state.chatOpen, true);
  const v = app.renderVals();
  assert.equal(v.chatHaySugerencias, true);
  await v.chatSugerencias[0].preguntar();
  assert.equal(calls[2].opts.body.texto, '¿Cómo rastreo mi envío?');
  assert.equal(app.renderVals().chatHaySugerencias, false);
});

test('el texto del chat llega como texto plano y la vista no usa HTML crudo', async () => {
  for (const carga of XSS) {
    const { app } = setup();
    app.respuestas = [sesion, respuesta(carga, [{ tipo: 'ABRIR_PQR', etiqueta: carga }])];
    await app.enviarChat(enviar({ texto: carga }));
    const v = app.renderVals();
    assert.deepEqual(plano(v.chatFilas.map(f => f.texto)), [carga, carga]);
    assert.equal(v.chatAcciones[0].etiqueta, carga);
  }
  const vista = html.slice(html.indexOf('CHATBOT (HU-21)'), html.indexOf('<footer style="background:#14305c'));
  const editor = html.slice(html.indexOf('PREGUNTAS DEL CHATBOT (HU-21)'), html.indexOf('USUARIOS, ROLES Y PERMISOS (HU-11)'));
  for (const trozo of [vista, editor]) {
    assert.ok(trozo.length > 1000);
    assert.doesNotMatch(trozo, /innerHTML|dangerouslySetInnerHTML|<sc-html|unsafe/i);
  }
  assert.match(vista, /\{\{ m\.texto \}\}/);
});

test('el editor pide la lista con token y marca las inactivas', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt'; app.state.roles = 'ADMIN';
  app.respuestas = [{ ok: true, status: 200, data: [
    { id: 1, intencion: 'a_uno', categoria: 'pqr', pregunta: 'Pregunta uno', palabrasClave: ['uno', 'dos'], respuesta: 'r', activo: true, orden: 1 },
    { id: 2, intencion: 'b_dos', categoria: 'otra', pregunta: 'Pregunta dos', palabrasClave: ['tres'], respuesta: 'r', activo: false, orden: 2 }] }];
  app.goChatbotAdmin(); await new Promise(r => setImmediate(r));

  assert.equal(calls[0].ruta, '/api/admin/chatbot/faq');
  assert.notEqual(calls[0].opts.publico, true);
  const filas = app.renderVals().faqFilas;
  assert.equal(filas[0].alternarEtiqueta, 'Desactivar');
  assert.equal(filas[1].alternarEtiqueta, 'Activar');
  assert.match(filas[1].titulo, /^\(inactiva\)/);
  assert.match(filas[0].detalle, /a_uno · pqr · orden 1 · uno, dos/);
});

test('crear valida antes de llamar y envía palabras clave como lista', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt'; app.state.route = 'chatbot-admin';
  app.nuevaFaq();
  const completo = { intencion: 'envios_nocturnos', categoria: 'envios', pregunta: '¿Hay envíos nocturnos?', palabras: 'noche, nocturno ,', respuesta: 'Por ahora no hay envíos nocturnos.', orden: '4' };
  for (const [cambio, patron] of [[{ intencion: 'Con Mayus' }, /intención/], [{ categoria: 'x' }, /categoría/], [{ pregunta: 'cort' }, /pregunta/],
    [{ palabras: ' , ' }, /palabras clave/], [{ respuesta: 'corta' }, /respuesta/], [{ orden: '1000' }, /orden/], [{ orden: 'abc' }, /orden/]]) {
    app.state.faqForm = { ...completo, id: null, ...cambio };
    app.state.faqError = '';
    await app.guardarFaq(enviar({}));
    assert.match(app.state.faqError, patron, JSON.stringify(cambio));
  }
  assert.equal(calls.length, 0);

  app.state.faqForm = { ...completo, id: null };
  app.respuestas = [{ ok: true, status: 201, data: {} }, { ok: true, status: 200, data: [] }];
  await app.guardarFaq(enviar({}));
  assert.equal(calls[0].ruta, '/api/admin/chatbot/faq');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(plano(calls[0].opts.body), { intencion: 'envios_nocturnos', categoria: 'envios', pregunta: '¿Hay envíos nocturnos?',
    palabrasClave: ['noche', 'nocturno'], respuesta: 'Por ahora no hay envíos nocturnos.', orden: 4 });
  assert.match(app.state.faqNotice, /Pregunta creada/);
  assert.equal(app.state.faqForm, null);
});

test('editar usa PUT sin la intención, y un 409 o 400 muestra lo que dice el servidor', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt'; app.state.route = 'chatbot-admin';
  app.editarFaq({ id: 7, intencion: 'a_uno', categoria: 'pqr', pregunta: 'Pregunta uno', palabrasClave: ['uno'], respuesta: 'Respuesta larga uno.', activo: true, orden: 3 });
  assert.equal(app.renderVals().faqEsNueva, false);
  assert.equal(app.renderVals().faqPalabras, 'uno');
  app.respuestas = [{ ok: false, status: 409, data: { detail: 'Ya existe una pregunta con la intención a_uno' } }];
  await app.guardarFaq(enviar({}));
  assert.equal(calls[0].ruta, '/api/admin/chatbot/faq/7');
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal('intencion' in calls[0].opts.body, false);
  assert.match(app.state.faqError, /Ya existe/);
  assert.notEqual(app.state.faqForm, null);
});

test('activar y desactivar mandan el valor contrario y recargan', async () => {
  const { app, calls } = setup();
  app.state.token = 'jwt'; app.state.route = 'chatbot-admin';
  app.respuestas = [{ ok: true, status: 200, data: {} }, { ok: true, status: 200, data: [] }];
  await app.alternarFaq({ id: 7, activo: true });
  assert.equal(calls[0].ruta, '/api/admin/chatbot/faq/7/activo');
  assert.deepEqual(plano(calls[0].opts.body), { activo: false });
  assert.equal(calls[1].ruta, '/api/admin/chatbot/faq');
  assert.match(app.state.faqNotice, /desactivada/);
});

test('salir del editor descarta el formulario y cerrar sesión limpia la lista', () => {
  const { app } = setup();
  app.state.route = 'chatbot-admin'; app.state.faqForm = { id: null }; app.state.faqLista = [{ id: 1 }];
  const antes = app._faqSession || 0;
  app.setState({ route: 'home' });
  assert.equal(app.state.faqForm, null);
  assert.deepEqual(plano(app.state.faqLista), []);
  assert.equal(app._faqSession, antes + 1);
  app.state.faqLista = [{ id: 1 }];
  app.olvidarSesion();
  assert.deepEqual(plano(app.state.faqLista), []);
});
