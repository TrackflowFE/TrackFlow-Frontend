// Comprueba que el código de barras generado se lee con un lector independiente
// (ZXing, cargado desde la CDN en el navegador integrado) y devuelve el número exacto.
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const path = require('node:path');
const { abrirEdge, evaluarEnPagina } = require('./edge.cjs');

const RAIZ = path.join(__dirname, '..', '..');
const SALIDA = path.join(__dirname, 'out');
const ZXING = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const NUMEROS = ['TFCACE109672DD', 'TF0123456789AB', 'TFABCDEFGHIJKL'];

function codigos(script) {
  class DCLogic {}
  const contexto = vm.createContext({ DCLogic, React: { createRef: () => ({ current: null }) } });
  vm.runInContext(script + '\nthis.codigoBarrasSvg = codigoBarrasSvg;', contexto);
  return NUMEROS.map(numero => ({ numero, uri: contexto.codigoBarrasSvg(numero) }));
}

function pagina(codigos) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Lectura de códigos</title></head>
<body>
<script>window.__codigos = ${JSON.stringify(codigos)};</script>
<script src="${ZXING}"></script>
<script>
window.__resultados = null;
(async () => {
  const salida = [];
  for (const item of window.__codigos) {
    try {
      const img = new Image();
      img.src = item.uri;
      await img.decode();
      const escala = 3;
      const canvas = document.createElement('canvas');
      canvas.width = img.width * escala;
      canvas.height = img.height * escala;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const fuente = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(fuente));
      const pistas = new Map([[ZXing.DecodeHintType.TRY_HARDER, true]]);
      const leido = new ZXing.MultiFormatReader().decode(bitmap, pistas);
      salida.push({ esperado: item.numero, leido: leido.getText(), formato: String(leido.getBarcodeFormat()) });
    } catch (e) {
      salida.push({ esperado: item.numero, error: String(e && e.message ? e.message : e) });
    }
  }
  window.__resultados = salida;
})();
</script>
</body></html>`;
}

async function main() {
  const html = readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  const script = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  const lista = codigos(script);

  mkdirSync(SALIDA, { recursive: true });
  const archivo = path.join(SALIDA, 'barcode.html');
  writeFileSync(archivo, pagina(lista), 'utf8');

  const edge = await abrirEdge();
  let resultados;
  try {
    resultados = await evaluarEnPagina(edge, pathToFileURL(archivo).href,
      'JSON.stringify(window.__resultados)', {
        esperarHasta: 'window.__resultados !== null',
        timeout: 60000
      });
  } finally {
    edge.cerrar();
  }

  const leidos = JSON.parse(resultados);
  const fallos = [];
  for (const item of leidos) {
    if (item.error) {
      fallos.push(`${item.esperado}: no se pudo leer (${item.error})`);
    } else if (item.leido !== item.esperado) {
      fallos.push(`${item.esperado}: se leyó ${item.leido}`);
    } else {
      console.log(`OK ${item.esperado} → ${item.leido} (${item.formato})`);
    }
  }

  if (fallos.length) {
    for (const fallo of fallos) console.error('FALLO: ' + fallo);
    process.exitCode = 1;
  } else {
    console.log(`OK: ZXing leyó los ${leidos.length} números exactamente.`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
