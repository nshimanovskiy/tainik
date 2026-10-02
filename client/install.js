// Страница установки на iPhone: определяет, откуда её открыли, и показывает нужные шаги.
import { qrEncode } from '/shared/qr.js';

const $ = (id) => document.getElementById(id);
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// Chrome, Firefox, Яндекс и др. на iOS добавляют в UA свои метки — профиль они не ставят
const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo|GSA\//.test(ua);
const iosVersion = (() => {
  const m = /OS (\d+)_(\d+)/.exec(ua) || /Version\/(\d+)\.(\d+)/.exec(ua);
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
})();

if (standalone) {
  $('installed').hidden = false;
  $('steps').hidden = true;
} else if (!isIOS) {
  $('not-ios').hidden = false;
  const url = location.origin + '/ios';
  $('page-url').textContent = url;
  renderQr($('qr'), url);
} else {
  if (otherBrowser) $('not-safari').hidden = false;
  if (iosVersion && iosVersion < 18.04) $('old-ios').hidden = false;
}

$('copy-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.origin + '/ios');
    $('copy-url').textContent = 'Скопировано — вставьте в Safari';
  } catch {
    $('copy-url').textContent = location.origin + '/ios';
  }
});

function renderQr(container, text) {
  const NS = 'http://www.w3.org/2000/svg';
  const m = qrEncode(text);
  const size = m.length + 8;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(NS, 'path');
  let d = '';
  m.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + 4} ${y + 4}h1v1h-1z`)));
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  container.replaceChildren(svg);
}
