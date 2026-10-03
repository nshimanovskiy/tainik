// Главная страница: вкладки «О Тайнике» / «Скачать», файлы последнего выпуска с этого сервера.
import { t, LANG, LOCALE, setLang, translateDom } from '/shared/i18n.js';

// Главная открывается всегда, даже если вы уже вошли: в чаты — кнопкой «Перейти в чаты».
// Сразу в мессенджер — только значок на экране «Домой» (старые значки вели на /)
// и ссылки на чат из уведомлений (/#chat=…). ?home — главная в любом случае.
const hasAccount = (() => {
  try {
    const list = JSON.parse(localStorage.getItem('tainik:accounts') || '[]');
    return !!localStorage.getItem('tainik:server') || (Array.isArray(list) && list.some((a) => a && a.username));
  } catch {
    return false;
  }
})();
(() => {
  const q = new URLSearchParams(location.search);
  if (q.has('home')) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone || location.hash.startsWith('#chat=')) {
    location.replace('/app' + (location.hash.startsWith('#chat=') ? location.hash : ''));
  }
})();

const $ = (id) => document.getElementById(id);
translateDom();
// Переключатель языка: показывает язык, на который переключит
$('lang-switch').textContent = LANG === 'ru' ? 'EN' : 'RU';
$('lang-switch').title = LANG === 'ru' ? 'English' : 'Русский';
$('lang-switch').addEventListener('click', () => {
  setLang(LANG === 'ru' ? 'en' : 'ru');
  location.reload();
});
// Вы уже вошли — главная кнопка ведёт в чаты
if (hasAccount) {
  $('open-chats').classList.add('primary');
  $('hero-open').textContent = t('Перейти в чаты');
  $('hero-open').classList.add('primary');
  $('hero-download').classList.remove('primary');
  $('hero-open').after($('hero-download'));
}
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- Вкладки ----------
function showTab() {
  const tab = location.hash === '#download' ? 'download' : 'about';
  for (const name of ['about', 'download']) {
    $(name).hidden = name !== tab;
    $('tab-' + name).setAttribute('aria-selected', String(name === tab));
    $('tab-' + name).classList.toggle('active', name === tab);
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
const OS_NAME = { ios: t('iPhone и iPad'), android: 'Android', windows: 'Windows', mac: 'macOS', linux: 'Linux', web: t('браузера') };
let macArch = 'arm64'; // большинство Mac с 2020 года — Apple Silicon
navigator.userAgentData?.getHighEntropyValues?.(['architecture']).then((v) => {
  if (v.architecture === 'x86') macArch = 'x64';
  if (release) render();
}).catch(() => {});

const heroBtn = $('hero-download');
if (os === 'ios') {
  heroBtn.textContent = t('Установить на iPhone');
  heroBtn.href = '/ios';
} else if (os !== 'web') {
  heroBtn.textContent = t('Скачать для {0}', OS_NAME[os]);
}
$('hero-hint').textContent =
  os === 'ios'
    ? t('Для iPhone — значок на экране «Домой», устанавливается из Safari.')
    : t('Есть версии для Windows, macOS, Linux, Android и iPhone.');

// ---------- Выпуск ----------
const LABEL = {
  win: [t('Установщик'), '.exe'],
  'win-portable': [t('Без установки'), 'portable .exe'],
  'mac-arm64': ['Apple Silicon', 'M1–M4, .dmg'],
  'mac-x64': ['Intel', '.dmg'],
  'linux-appimage': ['AppImage', t('любой дистрибутив')],
  'linux-deb': [t('Пакет .deb'), 'Ubuntu, Debian'],
  android: [t('Приложение'), '.apk'],
};
const RECOMMEND = {
  windows: () => ['win', t('Тайник для Windows')],
  mac: () => [`mac-${macArch}`, t('Тайник для macOS ({0})', macArch === 'arm64' ? 'Apple Silicon' : 'Intel')],
  linux: () => ['linux-appimage', t('Тайник для Linux (AppImage)')],
  android: () => ['android', t('Тайник для Android')],
};
const sizeFmt = (b) => (b >= 1048576 ? t('{0} МБ', (b / 1048576).toFixed(0)) : t('{0} КБ', Math.max(1, Math.round(b / 1024))));
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });

let release = null;
let loading = null;
function loadReleases() {
  loading ||= fetch('/api/releases', { cache: 'no-store' })
    .then(async (r) => {
      if (r.status === 404) throw new Error(t('На этом сервере загрузки не настроены.'));
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || t('Сведения о выпуске недоступны.'));
      release = data;
      render();
    })
    .catch((e) => {
      $('dl-version').textContent = t('Файлы для установки сейчас недоступны.');
      $('dl-error').hidden = false;
      $('dl-error').textContent = t('{0} Веб-версия и установка на iPhone работают — они ниже.', e.message);
      for (const box of document.querySelectorAll('[data-files]')) {
        if (box.dataset.files) box.replaceChildren(el('span', 'muted small', t('временно недоступно')));
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
  const when = release.publishedAt ? t(' от {0}', dateFmt.format(new Date(release.publishedAt))) : '';
  $('dl-version').textContent = t('Версия {0}{1}', release.version, when);

  for (const box of document.querySelectorAll('[data-files]')) {
    if (!box.dataset.files) continue;
    const files = box.dataset.files.split(',').map((p) => byPlatform[p]).filter(Boolean);
    box.replaceChildren(...(files.length ? files.map(fileLink) : [el('span', 'muted small', t('нет в этом выпуске'))]));
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
    const a = el('a', '', t('контрольные суммы'));
    a.href = sums.url;
    links.append(t(' Проверка целостности: '), a, '.');
  }
  if (release.page) {
    const a = el('a', '', t('Все выпуски и что нового — на GitHub'));
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
