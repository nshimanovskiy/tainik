// Карточка уведомления. Данные приходят из главного процесса (window.toast — мост toast-preload.cjs);
// весь текст — только через textContent, картинка — только проверенный data:-URL.
'use strict';
const $ = (id) => document.getElementById(id);
const card = $('card');
let data = null;

function fit() {
  // Высота окна — по карточке (+ поля под тень)
  window.toast.size(Math.ceil(card.getBoundingClientRect().height + 12));
}

function render(d) {
  data = d;
  card.classList.toggle('call', !!d.call);
  $('title').textContent = d.title;
  $('account').textContent = d.account || '';
  $('text').textContent = d.body;
  const av = $('avatar');
  if (d.avatar) {
    av.textContent = '';
    av.style.backgroundColor = '';
    av.style.backgroundImage = `url("${d.avatar}")`;
  } else {
    av.style.backgroundImage = '';
    av.textContent = d.letter || '';
    av.style.backgroundColor = `hsl(${d.hue || 0} 42% 42%)`;
  }
  $('close').setAttribute('aria-label', d.labels.close);
  $('close').title = d.labels.close;
  $('reply-input').placeholder = d.labels.placeholder;
  $('reply-send').setAttribute('aria-label', d.labels.send);
  const acts = $('actions');
  acts.replaceChildren();
  const btn = (text, cls, act) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (act === 'reply') return openReply();
      window.toast.act(act);
    });
    acts.append(b);
  };
  if (d.call) {
    btn(d.labels.decline, 'danger', 'decline');
    btn(d.labels.accept, 'ok', 'accept');
  } else if (d.canReply && $('reply').hidden) {
    btn(d.labels.reply, 'plain', 'reply');
  }
  requestAnimationFrame(() => {
    card.classList.add('in');
    fit();
  });
}

function openReply() {
  $('actions').replaceChildren();
  $('reply').hidden = false;
  window.toast.act('focus'); // окну нужен фокус, чтобы печатать
  $('reply-input').focus();
  fit();
}

window.toast.onData(render);
window.toast.onLeave(() => card.classList.add('out'));
card.addEventListener('click', (e) => {
  if (e.target.closest('form, .close, .actions')) return;
  window.toast.act('open');
});
$('close').addEventListener('click', (e) => {
  e.stopPropagation();
  window.toast.act('close');
});
card.addEventListener('mouseenter', () => window.toast.act('hover'));
card.addEventListener('mouseleave', () => window.toast.act('unhover'));
$('reply').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('reply-input').value.trim();
  if (text) window.toast.reply(text);
});
$('reply-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.toast.act('close');
});
