// NFR-20: comprueba que el comprobante cabe en media hoja carta y que la impresión
// ocupa una sola página. Toma el CSS y la plantilla del propio index.html, genera el
// PDF con Edge sin ventana y mide la caja con getBoundingClientRect en modo impresión.
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const path = require('node:path');
const { abrirEdge, evaluarEnPagina } = require('./edge.cjs');

const RAIZ = path.join(__dirname, '..', '..');
const SALIDA = path.join(__dirname, 'out');
const MM_A_PX = 96 / 25.4;

const RECEIPT = {
  trackingNumber: 'TFCACE109672DD',
  registeredAt: '2026-11-16T15:04:05.123456Z',
  senderName: 'Ana Torres',
  originCity: 'MEDELLÍN - ANTIOQUIA',
  recipientName: 'Luis Gómez',
  destinationCity: 'BOGOTÁ D.C. - BOGOTÁ'
};

function escapar(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extraer(html) {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const plantilla = html.match(/<div class="tf-comprobante">[\s\S]*?<\/div>\s*<\/sc-if>/)[0]
    .replace(/\s*<\/sc-if>$/, '');
  const script = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  return { css, plantilla, script };
}

function vista(script) {
  class DCLogic {}
  const contexto = vm.createContext({ DCLogic, React: { createRef: () => ({ current: null }) } });
  vm.runInContext(script + '\nthis.vistaComprobante = vistaComprobante;', contexto);
  return contexto.vistaComprobante(RECEIPT, 'https://trackflow.example/');
}

function paginaDePrueba(css, plantilla, valores) {
  const comprobante = plantilla
    .replace(/\{\{\s*comp_numero\s*\}\}/g, escapar(valores.numero))
    .replace(/\{\{\s*comp_barras\s*\}\}/g, valores.barras)
    .replace(/\{\{\s*comp_fecha\s*\}\}/g, escapar(valores.fecha))
    .replace(/\{\{\s*comp_origen\s*\}\}/g, escapar(valores.origen))
    .replace(/\{\{\s*comp_destino\s*\}\}/g, escapar(valores.destino))
    .replace(/\{\{\s*comp_destinatario\s*\}\}/g, escapar(valores.destinatario))
    .replace(/\{\{\s*comp_remitente\s*\}\}/g, escapar(valores.remitente))
    .replace(/\{\{\s*comp_rastreo\s*\}\}/g, escapar(valores.rastreo));

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Comprobante</title>
<style>${css}</style></head>
<body>
  <div class="tf-app-root" style="min-height:2400px;display:flex;flex-direction:column">
    <header>Cabecera de la aplicación</header>
    <main><p>Contenido largo que no debe imprimirse.</p></main>
    <footer>Pie</footer>
  </div>
  ${comprobante}
</body></html>`;
}

function contarPaginas(pdf) {
  const texto = pdf.toString('latin1');
  const paginas = (texto.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const caja = texto.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  return {
    paginas,
    ancho: caja ? Number(caja[1]) : null,
    alto: caja ? Number(caja[2]) : null
  };
}

async function main() {
  const html = readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  const { css, plantilla, script } = extraer(html);
  const valores = vista(script);

  mkdirSync(SALIDA, { recursive: true });
  const archivoHtml = path.join(SALIDA, 'comprobante.html');
  const archivoPdf = path.join(SALIDA, 'comprobante.pdf');
  writeFileSync(archivoHtml, paginaDePrueba(css, plantilla, valores), 'utf8');

  const edge = await abrirEdge();
  let medidas;
  let pdf;
  try {
    medidas = JSON.parse(await evaluarEnPagina(edge, pathToFileURL(archivoHtml).href, `(() => {
      const el = document.querySelector('.tf-comprobante');
      const r = el.getBoundingClientRect();
      return JSON.stringify({
        display: getComputedStyle(el).display,
        top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom
      });
    })()`, { media: 'print', ancho: 816, alto: 1056 }));

    const impreso = await edge.enviar('Page.printToPDF', {
      printBackground: true, preferCSSPageSize: true
    });
    pdf = Buffer.from(impreso.data, 'base64');
    writeFileSync(archivoPdf, pdf);
  } finally {
    edge.cerrar();
  }

  const { paginas, ancho, alto } = contarPaginas(pdf);
  const fallos = [];
  const comprobar = (condicion, mensaje) => { if (!condicion) fallos.push(mensaje); };

  comprobar(medidas.display === 'block', `el comprobante no se muestra al imprimir (display: ${medidas.display})`);
  comprobar(medidas.top >= 0, `la caja empieza fuera de la página (top: ${medidas.top}px)`);
  comprobar(medidas.width <= 190 * MM_A_PX + 1,
    `ancho ${(medidas.width / MM_A_PX).toFixed(1)}mm supera los 190mm`);
  comprobar(medidas.bottom <= 139.7 * MM_A_PX + 1,
    `la caja llega a ${(medidas.bottom / MM_A_PX).toFixed(1)}mm, más allá de los 139.7mm superiores`);
  comprobar(paginas === 1, `el PDF tiene ${paginas} páginas`);
  comprobar(ancho === 612 && alto === 792, `tamaño de página ${ancho}x${alto}pt, se esperaba carta 612x792pt`);

  console.log(`Caja: ${(medidas.width / MM_A_PX).toFixed(1)} x ${(medidas.height / MM_A_PX).toFixed(1)}mm, `
    + `desde ${(medidas.top / MM_A_PX).toFixed(1)}mm hasta ${(medidas.bottom / MM_A_PX).toFixed(1)}mm`);
  console.log(`PDF: ${paginas} página(s), ${ancho}x${alto}pt → ${archivoPdf}`);

  if (fallos.length) {
    for (const fallo of fallos) console.error('FALLO: ' + fallo);
    process.exitCode = 1;
  } else {
    console.log('OK: una página carta y el comprobante dentro de la mitad superior.');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
