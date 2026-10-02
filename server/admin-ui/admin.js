// Панель администратора: читает /api/overview каждые 5 секунд и рисует таблицу.
// Весь текст — только через textContent.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function ago(ts, now) {
  if (!ts) return 'никогда';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин. назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч. назад`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} дн. назад`;
  return dateFmt.format(ts);
}
function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'меньше минуты';
  if (m < 60) return `${m} мин.`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} ч. ${m % 60} мин.` : `${Math.floor(h / 24)} дн. ${h % 24} ч.`;
}

let data = null;
let fetchedAt = 0;

function render() {
  if (!data) return;
  const { totals, users, now, version, startedAt } = data;
  $('t-users').textContent = totals.users;
  $('t-online').textContent = totals.online;
  $('t-devices').textContent = totals.devices;
  $('t-conns').textContent = totals.connections;
  $('t-queued').textContent = totals.queued;
  $('version').textContent = `Сервер ${version}, работает ${duration(now - startedAt)}`;

  const q = $('search').value.trim().toLowerCase();
  const onlyOnline = $('only-online').checked;
  const list = users
    .filter((u) => !onlyOnline || u.online)
    .filter(
      (u) =>
        !q ||
        u.name.includes(q) ||
        u.devices.some((d) => d.name.toLowerCase().includes(q) || (d.ip || '').includes(q))
    )
    .sort((a, b) => b.online - a.online || (b.lastSeen || 0) - (a.lastSeen || 0) || a.name.localeCompare(b.name));

  const rows = list.map((u) => {
    const tr = el('tr', u.online ? 'on' : '');
    const name = el('td', 'name');
    name.append(el('b', '', u.name));
    if (u.push) name.append(el('span', 'tag', 'push'));
    if (u.presenceHidden) name.append(el('span', 'tag', 'статус скрыт'));
    const status = el('td', 'status');
    status.append(el('span', 'dot' + (u.online ? ' on' : '')), document.createTextNode(u.online ? 'в сети' : `был(а) ${ago(u.lastSeen, now)}`));
    const devs = el('td', 'devices');
    for (const d of u.devices) {
      const row = el('div', 'device' + (d.online ? ' on' : ''));
      row.append(el('span', 'dev-name', `№${d.id} ${d.name}`));
      if (d.online) {
        row.append(el('code', 'ip', d.ip || '—'));
        row.append(el('span', 'muted small', `с ${timeFmt.format(d.since)}`));
      } else {
        row.append(el('span', 'muted small', ago(d.lastSeen, now)));
      }
      devs.append(row);
    }
    if (!u.devices.length) devs.append(el('span', 'muted small', 'нет устройств'));
    const created = el('td', 'muted small', u.createdAt ? fullFmt.format(u.createdAt) : '—');
    const queued = el('td', 'num', String(u.queued));
    tr.append(name, status, devs, created, queued);
    return tr;
  });
  $('rows').replaceChildren(...rows);
  $('empty').hidden = rows.length > 0;
}

function renderUpdated() {
  if (!fetchedAt) return;
  const s = Math.round((Date.now() - fetchedAt) / 1000);
  $('updated').textContent = s < 2 ? 'обновлено только что' : `обновлено ${s} с назад`;
}

async function load() {
  try {
    const r = await fetch('api/overview', { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 401) return location.reload(); // сессия истекла — на страницу входа
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    fetchedAt = Date.now();
    render();
  } catch {
    $('updated').textContent = 'нет связи с сервером';
  }
  renderUpdated();
}

$('search').addEventListener('input', render);
$('only-online').addEventListener('change', render);
load();
setInterval(load, 5000);
setInterval(renderUpdated, 1000);
