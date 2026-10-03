// Главная страница: вкладки «О Тайнике» / «Скачать», файлы последнего выпуска с этого сервера.

// Уже пользуетесь веб-версией (есть аккаунт в этом браузере) или открыли Тайник с экрана
// «Домой» — сразу в мессенджер. ?home — показать главную в любом случае.
(() => {
  const q = new URLSearchParams(location.search);
  if (q.has('home')) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let hasAccount = false;
  try {
    const list = JSON.parse(localStorage.getItem('tainik:accounts') || '[]');
    hasAccount = !!localStorage.getItem('tainik:server') || (Array.isArray(list) && list.some((a) => a && a.username));
  } catch {}
  if (standalone || hasAccount || location.hash.startsWith('#chat=')) {
    location.replace('/app' + (location.hash.startsWith('#chat=') ? location.hash : ''));
  }
})();

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- Вкладки ----------
function showTab() {
  const tab = location.hash === '#download' ? 'download' : 'about';
  for (const t of ['about', 'download']) {
    $(t).hidden = t !== tab;
    $('tab-' + t).setAttribute('aria-selected', String(t === tab));
    $('tab-' + t).classList.toggle('active', t === tab);
  }
  if (tab === 'download') loadReleases();
}
window.addEventListener('hashchange', () => {
  showTab();
  scrollTo({ top: 0 });
});

// ---------- Платформа посетителя ----------
const ua = navigator.userAgent;
const touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
const os = /iPad|iPhone|iPod/.test(ua) || touchMac
  ? 'ios'
  : /Android/.test(ua)
    ? 'android'
    : /Windows/.test(ua)
      ? 'windows'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'mac'
        : /Linux|X11|CrOS/.test(ua)
          ? 'linux'
          : 'web';
const OS_NAME = { ios: 'iPhone и iPad', android: 'Android', windows: 'Windows', mac: 'macOS', linux: 'Linux', web: 'браузера' };
let macArch = 'arm64'; // большинство Mac с 2020 года — Apple Silicon
navigator.userAgentData?.getHighEntropyValues?.(['architecture']).then((v) => {
  if (v.architecture === 'x86') macArch = 'x64';
  if (release) render();
}).catch(() => {});

const heroBtn = $('hero-download');
if (os === 'ios') {
  heroBtn.textContent = 'Установить на iPhone';
  heroBtn.href = '/ios';
} else if (os !== 'web') {
  heroBtn.textContent = `Скачать для ${OS_NAME[os]}`;
}
$('hero-hint').textContent =
  os === 'ios'
    ? 'Для iPhone — значок на экране «Домой», устанавливается из Safari.'
    : 'Есть версии для Windows, macOS, Linux, Android и iPhone.';

// ---------- Выпуск ----------
const LABEL = {
  win: ['Установщик', '.exe'],
  'win-portable': ['Без установки', 'portable .exe'],
  'mac-arm64': ['Apple Silicon', 'M1–M4, .dmg'],
  'mac-x64': ['Intel', '.dmg'],
  'linux-appimage': ['AppImage', 'любой дистрибутив'],
  'linux-deb': ['Пакет .deb', 'Ubuntu, Debian'],
  android: ['Приложение', '.apk'],
};
const RECOMMEND = {
  windows: () => ['win', 'Тайник для Windows'],
  mac: () => [`mac-${macArch}`, `Тайник для macOS (${macArch === 'arm64' ? 'Apple Silicon' : 'Intel'})`],
  linux: () => ['linux-appimage', 'Тайник для Linux (AppImage)'],
  android: () => ['android', 'Тайник для Android'],
};
const sizeFmt = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(0)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

let release = null;
let loading = null;
function loadReleases() {
  loading ||= fetch('/api/releases', { cache: 'no-store' })
    .then(async (r) => {
      if (r.status === 404) throw new Error('На этом сервере загрузки не настроены.');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Сведения о выпуске недоступны.');
      release = data;
      render();
    })
    .catch((e) => {
      $('dl-version').textContent = 'Файлы для установки сейчас недоступны.';
      $('dl-error').hidden = false;
      $('dl-error').textContent = `${e.message} Веб-версия и установка на iPhone работают — они ниже.`;
      for (const box of document.querySelectorAll('[data-files]')) {
        if (box.dataset.files) box.replaceChildren(el('span', 'muted small', 'временно недоступно'));
      }
    });
}

function fileLink(asset) {
  const [title, sub] = LABEL[asset.platform];
  const a = el('a', 'file');
  a.href = asset.url;
  a.setAttribute('download', '');
  a.append(el('span', '', title), el('span', 'muted small', `${sub} · ${sizeFmt(asset.size)}`));
  return a;
}

function render() {
  const byPlatform = Object.fromEntries(release.assets.map((a) => [a.platform, a]));
  const when = release.publishedAt ? ` от ${dateFmt.format(new Date(release.publishedAt))}` : '';
  $('dl-version').textContent = `Версия ${release.version}${when}`;

  for (const box of document.querySelectorAll('[data-files]')) {
    if (!box.dataset.files) continue;
    const files = box.dataset.files.split(',').map((p) => byPlatform[p]).filter(Boolean);
    box.replaceChildren(...(files.length ? files.map(fileLink) : [el('span', 'muted small', 'нет в этом выпуске')]));
  }
  for (const card of document.querySelectorAll('.platform')) card.classList.toggle('mine', card.dataset.os === os);

  const rec = RECOMMEND[os]?.();
  const asset = rec && byPlatform[rec[0]];
  $('dl-recommended').hidden = !asset;
  if (asset) {
    $('rec-title').textContent = rec[1];
    $('rec-meta').textContent = `${release.version} · ${sizeFmt(asset.size)}`;
    $('rec-link').href = asset.url;
    $('rec-link').setAttribute('download', '');
    heroBtn.href = asset.url;
    heroBtn.setAttribute('download', '');
  }

  const links = $('dl-links');
  links.replaceChildren();
  const sums = byPlatform.sums;
  if (sums) {
    const a = el('a', '', 'контрольные суммы');
    a.href = sums.url;
    links.append(' Проверка целостности: ', a, '.');
  }
  if (release.page) {
    const a = el('a', '', 'Все выпуски и что нового — на GitHub');
    a.href = release.page;
    a.rel = 'noopener';
    links.append(' ', a, '.');
  }
}

showTab();
// Вкладки — не якоря: браузер не должен прокручивать к ним страницу при открытии ссылки
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
requestAnimationFrame(() => scrollTo({ top: 0 }));
// Кнопка «Скачать» сразу даёт файл для вашей системы — сведения о выпуске загружаем заранее
if (os !== 'ios' && os !== 'web') loadReleases();
