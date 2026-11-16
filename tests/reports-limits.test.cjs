const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

function setup(props = {}) {
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
  return new context.TestComponent({ apiBaseUrl: 'https://api.example', ...props });
}

test('un periodo de 1939 se rechaza sin llamar a la API', async () => {
  const app = setup();
  app.state.repLimites = { minDate: '2026-01-01', maxDays: 366 };
  app.state.repDesde = '1939-01-01';
  app.state.repHasta = '1944-05-07';
  let llamadas = 0;
  app.api = async () => { llamadas += 1; return { ok: true, status: 200, data: {} }; };

  await app.cargarReporte();

  assert.equal(llamadas, 0);
  assert.match(app.state.repError, /inicio de la operación \(2026-01-01\)/);
  assert.equal(app.state.repErrorTitle, 'Periodo inválido');
});

test('un rango mayor al máximo se rechaza sin llamar a la API', async () => {
  const app = setup();
  app.state.repLimites = { minDate: '2026-01-01', maxDays: 366 };
  app.state.tieDesde = '2026-01-01';
  app.state.tieHasta = '2027-01-02';
  let llamadas = 0;
  app.api = async () => { llamadas += 1; return { ok: true, status: 200, data: {} }; };

  await app.cargarTiempos();

  assert.equal(llamadas, 0);
  assert.match(app.state.tieError, /367 días; el máximo es 366/);
});

test('sin límites cargados el formulario consulta igual y muestra el 400 del servidor', async () => {
  const app = setup();
  app.state.repDesde = '1939-01-01';
  app.state.repHasta = '1944-05-07';
  app.api = async () => ({ ok: false, status: 400, data: { title: 'Periodo inválido', detail: 'El periodo empieza antes del inicio de la operación (2026-01-01)' } });

  await app.cargarReporte();

  assert.equal(app.state.repErrorTitle, 'Periodo inválido');
  assert.match(app.state.repError, /2026-01-01/);
});
