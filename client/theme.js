// Тема оформления: как в системе (по умолчанию), светлая или тёмная; задел на свою тему.
// Обычный (не модульный) скрипт в <head>: ставит тему до отрисовки страницы, чтобы она не
// мигала при запуске. Выбор хранится на этом устройстве (localStorage), как размер шрифта.
//
// Своя тема — набор цветов (переменных CSS из style.css) поверх светлой или тёмной основы:
// { id: 'custom', base: 'dark', vars: { '--accent': '#d35d8b', ... } }. Цвета проверяются:
// только известные переменные и только значения вида #rgb / #rrggbb — без произвольного CSS.
(function () {
  'use strict';
  var KEY = 'tainik:theme';
  var CHOICES = ['system', 'light', 'dark', 'custom'];
  // Переменные, которые может задать своя тема
  var VARS = ['--bg', '--panel', '--surface', '--line', '--text', '--muted', '--accent', '--accent-ink', '--accent-soft', '--out', '--out-ink', '--in', '--danger', '--danger-soft', '--ok', '--warn'];
  var COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  var root = document.documentElement;
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function clean(t) {
    if (typeof t === 'string') t = { id: t };
    if (!t || CHOICES.indexOf(t.id) < 0) return { id: 'system' };
    if (t.id !== 'custom') return { id: t.id };
    var vars = {};
    for (var k in t.vars || {}) if (VARS.indexOf(k) >= 0 && COLOR.test(String(t.vars[k]))) vars[k] = String(t.vars[k]);
    return { id: 'custom', base: t.base === 'dark' ? 'dark' : 'light', vars: vars };
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      return clean(raw && raw.charAt(0) === '{' ? JSON.parse(raw) : raw);
    } catch (e) {
      return { id: 'system' };
    }
  }
  /** Светлая или тёмная основа выбранной темы. */
  function resolved(t) {
    if (t.id === 'light' || t.id === 'dark') return t.id;
    if (t.id === 'custom') return t.base;
    return dark && dark.matches ? 'dark' : 'light';
  }
  var current = load();
  function apply() {
    var base = resolved(current);
    root.setAttribute('data-theme', base);
    for (var i = 0; i < VARS.length; i++) root.style.removeProperty(VARS[i]);
    if (current.id === 'custom') for (var k in current.vars) root.style.setProperty(k, current.vars[k]);
    // Цвет строки состояния (телефон, PWA) — под фон темы
    var bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var j = 0; j < metas.length; j++) {
      metas[j].removeAttribute('media');
      if (bg) metas[j].setAttribute('content', bg);
    }
  }
  apply();
  // «Как в системе» — следить за сменой темы системы
  if (dark) {
    var onChange = function () {
      if (current.id === 'system') apply();
    };
    if (dark.addEventListener) dark.addEventListener('change', onChange);
    else if (dark.addListener) dark.addListener(onChange);
  }
  // Цвет строки состояния зависит от стилей — пересчитать, когда они загрузятся
  window.addEventListener('DOMContentLoaded', apply);

  window.tainikTheme = {
    /** Выбранная тема: { id, base?, vars? }. */
    get: function () {
      return JSON.parse(JSON.stringify(current));
    },
    /** Светлая или тёмная основа сейчас. */
    base: function () {
      return resolved(current);
    },
    /** Сменить тему: 'system' | 'light' | 'dark' или { id: 'custom', base, vars }. */
    set: function (t) {
      current = clean(t);
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
      } catch (e) {}
      apply();
      return this.get();
    },
    clean: clean,
    VARS: VARS.slice(),
  };
})();
