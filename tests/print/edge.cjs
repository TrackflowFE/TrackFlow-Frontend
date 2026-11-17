// Utilidades compartidas por las pruebas de impresión y de código de barras.
// Lanzan Edge en modo sin ventana y hablan con él por el protocolo DevTools.
const { spawn } = require('node:child_process');
const { existsSync, readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const EDGE_CANDIDATOS = [
  process.env.MSEDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/msedge'
].filter(Boolean);

function rutaEdge() {
  const encontrado = EDGE_CANDIDATOS.find(ruta => existsSync(ruta));
  if (!encontrado) {
    throw new Error('No se encontró Edge. Defina MSEDGE_PATH con la ruta del ejecutable.');
  }
  return encontrado;
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Arranca Edge sin ventana con depuración remota en un puerto libre. */
async function abrirEdge() {
  const perfil = mkdtempSync(path.join(tmpdir(), 'tf-edge-'));
  const proceso = spawn(rutaEdge(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${perfil}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const archivoPuerto = path.join(perfil, 'DevToolsActivePort');
  const limite = Date.now() + 20000;
  while (!existsSync(archivoPuerto)) {
    if (Date.now() > limite) {
      proceso.kill();
      throw new Error('Edge no abrió el puerto de depuración');
    }
    await esperar(100);
  }
  const [puerto] = readFileSync(archivoPuerto, 'utf8').split('\n');

  let destino;
  for (let intento = 0; intento < 100 && !destino; intento++) {
    try {
      const lista = await fetch(`http://127.0.0.1:${puerto}/json/list`).then(r => r.json());
      destino = lista.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) {
      // El endpoint todavía no escucha.
    }
    if (!destino) await esperar(100);
  }
  if (!destino) {
    proceso.kill();
    throw new Error('Edge no publicó una pestaña depurable');
  }

  const ws = new WebSocket(destino.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let siguienteId = 0;
  const pendientes = new Map();
  const eventos = new Map();
  ws.addEventListener('message', mensaje => {
    const datos = JSON.parse(mensaje.data);
    if (datos.id && pendientes.has(datos.id)) {
      const { resolve, reject } = pendientes.get(datos.id);
      pendientes.delete(datos.id);
      if (datos.error) reject(new Error(datos.error.message));
      else resolve(datos.result);
      return;
    }
    if (datos.method && eventos.has(datos.method)) {
      eventos.get(datos.method).forEach(fn => fn(datos.params));
      eventos.delete(datos.method);
    }
  });

  const enviar = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++siguienteId;
    pendientes.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const unaVez = method => new Promise(resolve => {
    if (!eventos.has(method)) eventos.set(method, []);
    eventos.get(method).push(resolve);
  });

  const cerrar = () => {
    try { ws.close(); } catch (e) {}
    proceso.kill();
    try { rmSync(perfil, { recursive: true, force: true }); } catch (e) {}
  };

  return { enviar, unaVez, cerrar };
}

/** Carga una página, espera su carga y evalúa una expresión en ella. */
async function evaluarEnPagina(edge, url, expresion, opciones = {}) {
  await edge.enviar('Page.enable');
  await edge.enviar('Runtime.enable');
  if (opciones.ancho) {
    await edge.enviar('Emulation.setDeviceMetricsOverride', {
      width: opciones.ancho, height: opciones.alto || 1056, deviceScaleFactor: 1, mobile: false
    });
  }
  if (opciones.media) {
    await edge.enviar('Emulation.setEmulatedMedia', { media: opciones.media });
  }
  const cargada = edge.unaVez('Page.loadEventFired');
  await edge.enviar('Page.navigate', { url });
  await cargada;
  if (opciones.esperarHasta) {
    const limite = Date.now() + (opciones.timeout || 30000);
    while (Date.now() < limite) {
      const listo = await edge.enviar('Runtime.evaluate', {
        expression: opciones.esperarHasta, returnByValue: true
      });
      if (listo.result && listo.result.value) break;
      await esperar(150);
    }
  }
  const resultado = await edge.enviar('Runtime.evaluate', {
    expression: expresion, returnByValue: true, awaitPromise: true
  });
  if (resultado.exceptionDetails) {
    throw new Error('La página falló: ' + (resultado.exceptionDetails.text || 'error desconocido'));
  }
  return resultado.result.value;
}

module.exports = { abrirEdge, evaluarEnPagina, rutaEdge, esperar };
