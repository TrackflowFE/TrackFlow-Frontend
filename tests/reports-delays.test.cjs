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
  vm.runInContext(source + '\nthis.TestComponent = Component; this.diasYHoras = diasYHoras;', context);
  return { app: new context.TestComponent({ apiBaseUrl: 'https://api.example' }), context };
}

test('diasYHoras muestra días y la parte menor en horas', () => {
  const { context } = setup();
  assert.equal(context.diasYHoras(2068), '86 d 4 h');
  assert.equal(context.diasYHoras(48), '2 d');
  assert.equal(context.diasYHoras(23), '23 h');
  assert.equal(context.diasYHoras(0), 'menos de 1 h');
  assert.equal(context.diasYHoras(null), 'menos de 1 h');
});

test('vistaRetrasados usa los textos en días y horas de la API', () => {
  const { app } = setup();
  app.state.retData = {
    shipments: [{
      trackingNumber: 'TF0123456789AB', status: 'IN_CUSTODY', severity: 'CRITICAL',
      hoursStopped: 2068, hoursExpected: 24, hoursOver: 2044,
      stopped: { seconds: 7444800, text: '86 d 4 h' },
      expected: { seconds: 86400, text: '1 d' },
      over: { seconds: 7358400, text: '85 d 4 h' }
    }]
  };

  const fila = app.vistaRetrasados(app.state).retFilas[0];

  assert.equal(fila.horas, '86 d 4 h de 1 d esperadas');
  assert.equal(fila.exceso, '+85 d 4 h');
  assert.equal(fila.estado, 'En custodia');
});

test('vistaRetrasados calcula el texto con una respuesta antigua que solo trae horas', () => {
  const { app } = setup();
  app.state.retData = {
    shipments: [{
      trackingNumber: 'TF0123456789AB', status: 'IN_TRANSIT', severity: 'LOW',
      hoursStopped: 48, hoursExpected: 24, hoursOver: 24
    }]
  };

  const fila = app.vistaRetrasados(app.state).retFilas[0];

  assert.equal(fila.horas, '2 d de 1 d esperadas');
  assert.equal(fila.exceso, '+1 d');
});
