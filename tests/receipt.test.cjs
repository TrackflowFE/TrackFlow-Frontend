const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const RECEIPT = {
  trackingNumber: 'TF0123456789AB',
  registeredAt: '2026-11-16T15:04:05.123456Z',
  senderName: 'Ana Torres',
  originCity: 'MEDELLÍN - ANTIOQUIA',
  recipientName: 'Luis Gómez',
  destinationCity: 'BOGOTÁ D.C. - BOGOTÁ'
};

function setup(options = {}) {
  const printed = { count: 0 };
  const requests = [];
  class DCLogic {
    constructor(props) { this.props = props; }
    setState(update, cb) {
      Object.assign(this.state, typeof update === 'function' ? update(this.state) : update);
      if (cb) cb();
    }
  }
  const context = vm.createContext({
    DCLogic,
    React: { createRef: () => ({ current: null }) },
    AbortController, setTimeout, clearTimeout,
    navigator: options.navigator || { clipboard: { writeText: async () => {} } },
    window: { print: () => { printed.count += 1; } },
    fetch: async (url, opts) => {
      requests.push({ url, options: opts });
      return options.fetchResponse || { ok: true, status: 200, json: async () => RECEIPT };
    }
  });
  vm.runInContext(source + '\nthis.TestComponent = Component; this.codigo128 = codigo128;'
    + ' this.codigoBarrasSvg = codigoBarrasSvg; this.vistaComprobante = vistaComprobante;', context);
  const app = new context.TestComponent({ apiBaseUrl: 'https://api.example' });
  return { app, printed, requests, context };
}

test('codigo128 usa inicio B, parada y el dígito de control correcto', () => {
  const { context } = setup();
  // Array.from evita comparar un arreglo de otro realm (vm) con deepStrictEqual.
  const anchos = Array.from(context.codigo128('TF0123456789AB'));

  assert.deepEqual(anchos.slice(0, 6), [2, 1, 1, 2, 1, 4], 'inicio B');
  assert.deepEqual(anchos.slice(-7), [2, 3, 3, 1, 1, 1, 2], 'parada');
  assert.equal(anchos.reduce((suma, ancho) => suma + ancho, 0), 11 * (14 + 3) + 2, 'módulos');
  // Control calculado a mano: (104 + Σ valor·posición) mod 103 = 79 → patrón 134111.
  assert.deepEqual(anchos.slice(6 + 14 * 6, 6 + 14 * 6 + 6), [1, 3, 4, 1, 1, 1], 'dígito de control');
});

test('codigoBarrasSvg devuelve una imagen con barras negras y el número legible', () => {
  const { context } = setup();
  const uri = context.codigoBarrasSvg('TF0123456789AB');

  assert.match(uri, /^data:image\/svg\+xml;charset=utf-8,/);
  const svg = decodeURIComponent(uri.split(',')[1]);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /fill="#000"/);
  assert.match(svg, /TF0123456789AB/);
});

test('vistaComprobante ignora teléfono, dirección y documento aunque lleguen', () => {
  const { context } = setup();
  const vista = context.vistaComprobante({
    ...RECEIPT, phone: '3000000001', address: 'Calle 1', documentNumber: '1000000001'
  });

  assert.equal(vista.numero, 'TF0123456789AB');
  assert.equal(vista.origen, 'MEDELLÍN - ANTIOQUIA');
  assert.equal(vista.destino, 'BOGOTÁ D.C. - BOGOTÁ');
  assert.equal(vista.destinatario, 'Luis Gómez');
  assert.equal(vista.remitente, 'Ana Torres');
  assert.match(vista.rastreo, /Consulte su envío en .* con este número\./);
  const serializado = JSON.stringify(vista);
  for (const privado of ['3000000001', 'Calle 1', '1000000001']) {
    assert.equal(serializado.includes(privado), false, 'no debe filtrar ' + privado);
  }
});

test('la fecha del comprobante no depende de la zona horaria del equipo', () => {
  const { context } = setup();
  const vista = context.vistaComprobante(RECEIPT);
  const script = "const d = new Date('2026-11-16T15:04:05.123456Z');"
    + "process.stdout.write(new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', year: 'numeric',"
    + " month: 'long', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d));";
  const enUtc = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' });
  const enTokio = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' });

  assert.equal(enUtc, enTokio);
  assert.equal(vista.fecha, enUtc);
});

test('imprimir tras registrar usa el receipt del POST y llama a window.print', () => {
  const { app, printed } = setup();
  app.state.created = { trackingNumber: RECEIPT.trackingNumber, receipt: RECEIPT };

  app.imprimirComprobante();

  assert.deepEqual(app.state.comprobante, RECEIPT);
  assert.equal(printed.count, 1);
});

test('reimprimir pide el comprobante con token y produce la misma vista', async () => {
  const { app, printed, requests } = setup();
  app.state.token = 'jwt-operador';
  app.state.tracking = { trackingNumber: RECEIPT.trackingNumber };

  await app.reimprimirComprobante();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.example/api/shipments/TF0123456789AB/receipt');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer jwt-operador');
  assert.equal(printed.count, 1);
  assert.deepEqual(app.state.comprobante, RECEIPT);
  assert.deepEqual(app.renderVals().comp_numero, RECEIPT.trackingNumber);
});

test('un 404 al reimprimir avisa y no imprime', async () => {
  const { app, printed } = setup();
  app.state.token = 'jwt-operador';
  app.state.tracking = { trackingNumber: RECEIPT.trackingNumber };
  app.api = async () => ({ ok: false, status: 404, data: null });

  await app.reimprimirComprobante();

  assert.equal(printed.count, 0);
  assert.match(app.state.copied, /aún se está registrando o no existe/);
});

test('si el rastreo da 404, la reimpresión usa el número buscado y la API 1 responde', async () => {
  const { app, printed, requests } = setup();
  app.state.token = 'jwt-operador';
  app.state.roles = 'OPERADOR';
  app.state.notFound = true;
  app.state.tracking = null;
  app.state.q = 'TFCACE109672DD';

  await app.reimprimirComprobante();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.example/api/shipments/TFCACE109672DD/receipt');
  assert.equal(printed.count, 1);
  assert.deepEqual(app.state.comprobante, RECEIPT);
});

test('la reimpresión no se ofrece sin sesión y se ignora un número mal formado', async () => {
  const anonimo = setup();
  anonimo.app.state.q = 'TFCACE109672DD';
  assert.equal(anonimo.app.renderVals().puedeReimprimir, false);

  const { app, printed, requests } = setup();
  app.state.token = 'jwt-operador';
  app.state.roles = 'ADMIN';
  app.state.q = 'no-es-guia';
  assert.equal(app.renderVals().puedeReimprimir, true);
  await app.reimprimirComprobante();
  assert.equal(requests.length, 0);
  assert.equal(printed.count, 0);
});

test('copiar confirma el número y avisa si el portapapeles falla', async () => {
  const { app } = setup();
  app.state.created = { trackingNumber: RECEIPT.trackingNumber };
  app.copiarNumeroCreado();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.copied, 'Número copiado');

  const falla = setup({ navigator: { clipboard: { writeText: async () => { throw new Error('sin permiso'); } } } });
  falla.app.state.created = { trackingNumber: RECEIPT.trackingNumber };
  falla.app.copiarNumeroCreado();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(falla.app.state.copied, /No se pudo copiar/);
});
