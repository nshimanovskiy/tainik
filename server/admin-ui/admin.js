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

// Действия: JSON + свой заголовок (сервер отклонит запрос без него — защита от CSRF)
async function act(name, body) {
  const r = await fetch('api/' + name, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Tainik-Admin': '1' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) return location.reload();
  const res = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(res.error || 'Ошибка ' + r.status);
  await load();
}
async function ban(ip) {
  const note = prompt(`Заблокировать ${ip}? С этого адреса нельзя будет подключиться, текущие подключения оборвутся.\n\nЗаметка (необязательно):`, '');
  if (note === null) return;
  try {
    await act('ban', { ip, note });
  } catch (e) {
    alert(e.message);
  }
}
const banned = (ip) => !!ip && !!data?.bans.some((b) => b.ip === ip);
function ipChip(ip, live) {
  const box = el('span', 'ip-box');
  box.append(el('code', 'ip' + (live ? '' : ' last') + (banned(ip) ? ' banned' : ''), ip));
  if (!banned(ip)) {
    const b = el('button', 'mini', 'блок');
    b.type = 'button';
    b.title = 'Заблокировать этот IP';
    b.addEventListener('click', () => ban(ip));
    box.append(b);
  }
  return box;
}

// Официальная галочка — такая же, как в мессенджере
function verifiedBadge() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'official');
  svg.setAttribute('aria-label', 'Официальный аккаунт');
  const t = document.createElementNS(NS, 'title');
  t.textContent = 'Официальный аккаунт';
  const bg = document.createElementNS(NS, 'path');
  bg.setAttribute('class', 'official-bg');
  bg.setAttribute('d', 'M12 1.5a10.5 10.5 0 1 0 0 21a10.5 10.5 0 1 0 0-21z'); // круг, как в мессенджере
  const ck = document.createElementNS(NS, 'path');
  ck.setAttribute('class', 'official-check');
  ck.setAttribute('d', 'M7.6 12.3l3 3 5.8-6.2');
  svg.append(t, bg, ck);
  return svg;
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
  if (totals.media) {
    const mb = totals.media.bytes / 1048576;
    $('t-media').textContent = `${totals.media.n} · ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' ГБ' : mb.toFixed(mb < 10 ? 1 : 0) + ' МБ'}`;
  }
  $('version').textContent = `Сервер ${version}, работает ${duration(now - startedAt)}`;

  const q = $('search').value.trim().toLowerCase();
  const onlyOnline = $('only-online').checked;
  const list = users
    .filter((u) => !onlyOnline || u.online)
    .filter(
      (u) =>
        !q ||
        u.name.includes(q) ||
        String(u.uid) === q.replace(/^#/, '') ||
        (q === 'галочка' && u.verified) ||
        (q === 'премиум' && u.premiumUntil > now) ||
        u.devices.some((d) => d.name.toLowerCase().includes(q) || (d.ip || '').includes(q) || (d.lastIp || '').includes(q))
    )
    .sort((a, b) => b.online - a.online || (b.lastSeen || 0) - (a.lastSeen || 0) || a.name.localeCompare(b.name));

  const rows = list.map((u) => {
    const tr = el('tr', u.online ? 'on' : '');
    const name = el('td', 'name');
    const b = el('b', '', u.name);
    if (u.verified) b.append(verifiedBadge());
    name.append(el('span', 'tag uid', `ID ${u.uid ?? '—'}`), b);
    if (u.push) name.append(el('span', 'tag', 'push'));
    if (u.presenceHidden) name.append(el('span', 'tag', 'статус скрыт'));
    const prem = u.premiumUntil && u.premiumUntil > now;
    if (prem) name.append(el('span', 'tag premium', `★ до ${dateFmt.format(u.premiumUntil)}`));
    if (u.coins) name.append(el('span', 'tag', `🪙 ${u.coins}`));
    const status = el('td', 'status');
    status.append(el('span', 'dot' + (u.online ? ' on' : '')), document.createTextNode(u.online ? 'в сети' : `был(а) ${ago(u.lastSeen, now)}`));
    const devs = el('td', 'devices');
    for (const d of u.devices) {
      const row = el('div', 'device' + (d.online ? ' on' : ''));
      row.append(el('span', 'dev-name', `№${d.id} ${d.name}`));
      row.append(el('span', 'tag ver', d.appVersion ? `v${d.appVersion}` : 'версия ?'));
      if (d.online) {
        if (d.ip) row.append(ipChip(d.ip, true));
        row.append(el('span', 'muted small', `с ${timeFmt.format(d.since)}`));
      } else {
        if (d.lastIp) row.append(ipChip(d.lastIp, false));
        row.append(el('span', 'muted small', ago(d.lastSeen, now)));
      }
      devs.append(row);
    }
    if (!u.devices.length) devs.append(el('span', 'muted small', 'нет устройств'));
    const created = el('td', 'muted small', u.createdAt ? fullFmt.format(u.createdAt) : '—');
    const queued = el('td', 'num', String(u.queued));
    const actions = el('td', 'actions');
    const del = el('button', 'danger', 'Удалить');
    del.type = 'button';
    del.addEventListener('click', async () => {
      const typed = prompt(
        `Удалить аккаунт ${u.name} безвозвратно?\n\nЕго устройства отключатся и сотрут ключи и переписку, недоставленные сообщения пропадут, имя освободится.\n\nЧтобы подтвердить, введите имя пользователя:`
      );
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== u.name) return alert('Имя не совпало — аккаунт не удалён');
      try {
        await act('delete-user', { name: u.name });
      } catch (e) {
        alert(e.message);
      }
    });
    const mark = el('button', 'ghost tick' + (u.verified ? ' on' : ''), u.verified ? 'Снять галочку' : 'Поставить галочку');
    mark.type = 'button';
    mark.title = u.verified ? 'Убрать официальную галочку' : 'Отметить аккаунт как официальный: галочка рядом с именем у всех собеседников';
    mark.addEventListener('click', async () => {
      if (u.verified && !confirm(`Снять официальную галочку у ${u.name}?`)) return;
      try {
        await act('verify', { name: u.name, verified: !u.verified });
      } catch (e) {
        alert(e.message);
      }
    });
    const pr = el('button', 'ghost', prem ? 'Премиум…' : 'Дать премиум');
    pr.type = 'button';
    pr.title = 'Продлить подписку вручную или отключить её';
    pr.addEventListener('click', async () => {
      const typed = prompt(
        `${u.name}: ${prem ? `подписка до ${fullFmt.format(u.premiumUntil)}` : 'подписки нет'}.\n\nНа сколько дней продлить? 0 — отключить сразу.`,
        prem ? '0' : '30'
      );
      if (typed === null || typed.trim() === '') return;
      try {
        await act('premium', { name: u.name, days: Number(typed.trim()) });
      } catch (e) {
        alert(e.message);
      }
    });
    const coins = el('button', 'ghost', 'Монеты…');
    coins.type = 'button';
    coins.title = 'Начислить или списать монеты';
    coins.addEventListener('click', async () => {
      const typed = prompt(`${u.name}: на балансе ${u.coins || 0} монет.\n\nСколько начислить? Чтобы списать — с минусом, например -100.`, '100');
      if (typed === null || typed.trim() === '') return;
      try {
        await act('coins', { name: u.name, delta: Number(typed.trim()) });
      } catch (e) {
        alert(e.message);
      }
    });
    const msg = el('button', 'ghost', 'Написать…');
    msg.type = 'button';
    msg.title = 'Сообщение в чат «Тайник» этого пользователя';
    msg.addEventListener('click', async () => {
      const typed = prompt(`${u.name}: сообщение придёт в чат «Тайник» (служебные уведомления).`, '');
      if (typed === null || !typed.trim()) return;
      try {
        await act('notice', { name: u.name, text: typed });
      } catch (e) {
        alert(e.message);
      }
    });
    actions.append(pr, coins, msg, mark, del);
    tr.append(name, status, devs, created, queued, actions);
    return tr;
  });
  $('rows').replaceChildren(...rows);
  $('empty').hidden = rows.length > 0;

  const bans = data.bans.map((b) => {
    const li = el('li');
    li.append(el('code', 'ip banned', b.ip));
    li.append(el('span', 'muted small', `${fullFmt.format(b.createdAt)}${b.note ? ' · ' + b.note : ''}`));
    const un = el('button', 'ghost', 'Разблокировать');
    un.type = 'button';
    un.addEventListener('click', () => act('unban', { ip: b.ip }).catch((e) => alert(e.message)));
    li.append(un);
    return li;
  });
  $('ban-list').replaceChildren(...bans);
  renderBilling(data.billing, now);
  $('no-bans').hidden = bans.length > 0;
}

// Подписка: тарифы и последние счета xRocket Pay
const PAY_STATUS = { active: 'ожидает оплаты', paid: 'оплачен', expired: 'истёк', cancelled: 'отменён', failed: 'не выставлен' };
function renderBilling(b, now) {
  $('billing').hidden = !b;
  if (!b) return;
  $('t-premium').textContent = b.active;
  $('billing-info').textContent =
    `Тарифы: ${b.plans.map((p) => `${p.days} дн. — ${p.price} ${p.currency}`).join(', ')}` +
    (b.currencies?.length > 1 ? ` · оплата: ${b.currencies.join(', ')} (не ${b.plans[0].currency} — по курсу xRocket)` : '') +
    (b.packs?.length ? ` · монеты: ${b.packs.map((p) => `${p.coins} — ${p.price} ${p.currency}`).join(', ')}; всего на балансах ${b.coins}` : '') +
    (b.plans[0]?.coins ? ` · Премиум за монеты: ${b.plans.map((p) => `${p.days} дн. — ${p.coins}`).join(', ')}` : '') +
    (b.testnet ? ' · тестовая сеть xRocket' : '') +
    (b.webhook ? '' : ' · вебхук не настроен (XROCKET_WEBHOOK_SECRET): оплаты подтверждаются только сверкой');
  const rows = b.payments.map((p) => {
    const tr = el('tr', p.status === 'paid' ? 'on' : '');
    tr.append(
      el('td', 'muted small', fullFmt.format(p.createdAt)),
      el('td', 'name', p.giftTo ? `${p.user} → 🎁 ${p.giftTo}` : p.user),
      el('td', '', p.coins ? `🪙 ${p.coins}` : `${p.days} дн.`),
      el('td', 'num', p.currency === 'COINS' ? `🪙 ${p.amount}` : `${p.amount} ${p.currency}`),
      el('td', 'small', PAY_STATUS[p.status] || p.status),
      el('td', 'muted small', p.paidAt ? ago(p.paidAt, now) : '')
    );
    return tr;
  });
  $('pay-rows').replaceChildren(...rows);
  $('no-pays').hidden = rows.length > 0;
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
    renderChats();
  } catch {
    $('updated').textContent = 'нет связи с сервером';
  }
  renderUpdated();
}

$('ban-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('ban-error').textContent = '';
  try {
    await act('ban', { ip: $('ban-ip').value.trim(), note: $('ban-note').value.trim() });
    $('ban-ip').value = '';
    $('ban-note').value = '';
  } catch (err) {
    $('ban-error').textContent = err.message;
  }
});
// ---------- Вкладки: пользователи / каналы и группы ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs .tab')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('tab-users').hidden = name !== 'users';
  $('tab-chats').hidden = name !== 'chats';
  try {
    sessionStorage.setItem('admin-tab', name);
  } catch {}
}
for (const b of document.querySelectorAll('.tabs .tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
try {
  if (sessionStorage.getItem('admin-tab') === 'chats') showTab('chats');
} catch {}

function verifyButton(kind, item, label) {
  const b = el('button', 'ghost tick' + (item.verified ? ' on' : ''), item.verified ? 'Снять галочку' : 'Поставить галочку');
  b.type = 'button';
  b.title = item.verified ? 'Убрать официальную галочку' : `Отметить ${kind} как официальный: галочка рядом с названием у всех`;
  b.addEventListener('click', async () => {
    if (item.verified && !confirm(`Снять галочку: ${label}?`)) return;
    try {
      await act('chat-verify', { id: item.id, verified: !item.verified });
    } catch (e) {
      alert(e.message);
    }
  });
  return b;
}

function renderChats() {
  if (!data?.chats) return;
  const { channels = [], groups = [] } = data.chats;
  $('news-box').hidden = !data.news;
  $('news-handle').textContent = data.news?.handle ? '@' + data.news.handle : '';
  $('tab-users-n').textContent = data.totals ? String(data.totals.users) : '';
  $('tab-chats-n').textContent = String(channels.length + groups.length);
  const q = $('chat-search').value.trim().toLowerCase().replace(/^#/, '');
  const onlyVer = $('only-verified').checked;
  const hit = (x, extra = []) =>
    (!onlyVer || x.verified) &&
    (!q || String(x.uid) === q || x.id.startsWith(q) || (x.owner || '').includes(q) || extra.some((s) => (s || '').toLowerCase().includes(q.replace(/^@/, ''))));

  const chans = channels.filter((c) => hit(c, [c.handle, c.title])).map((c) => {
    const tr = el('tr');
    const name = el('td', 'name');
    const b = el('b', '', c.title || (c.public ? '(без названия)' : '🔒 приватный канал'));
    if (c.verified) b.append(verifiedBadge());
    name.append(el('span', 'tag uid', `ID ${c.uid ?? '—'}`), b);
    if (c.handle) name.append(el('span', 'tag pub', '@' + c.handle));
    name.append(el('br'), el('code', 'cid', c.id));
    const actions = el('td', 'actions');
    actions.append(verifyButton('канал', c, c.title || c.handle || 'канал ' + c.uid));
    tr.append(name, el('td', '', c.owner), el('td', 'num', String(c.subs)), el('td', 'num', String(c.posts)), el('td', 'muted small', dateFmt.format(c.createdAt)), actions);
    return tr;
  });
  $('chan-rows').replaceChildren(...chans);
  $('no-chans').hidden = chans.length > 0;

  const grps = groups.filter((g) => hit(g)).map((g) => {
    const tr = el('tr');
    const name = el('td', 'name');
    const b = el('b', '', '👥 группа');
    if (g.verified) b.append(verifiedBadge());
    name.append(el('span', 'tag uid', `ID ${g.uid ?? '—'}`), b, el('br'), el('code', 'cid', g.id));
    const actions = el('td', 'actions');
    actions.append(verifyButton('группу', g, 'группа ' + g.uid));
    tr.append(
      name,
      el('td', '', g.owner || '—'),
      el('td', 'num', g.members ? `${g.members} · на сервере ${g.registered}` : `на сервере ${g.registered}`),
      el('td', 'muted small', dateFmt.format(g.createdAt)),
      el('td', 'muted small', ago(g.activeAt, data.now)),
      actions
    );
    return tr;
  });
  $('group-rows').replaceChildren(...grps);
  $('no-groups').hidden = grps.length > 0;
}
$('chat-search').addEventListener('input', renderChats);
$('only-verified').addEventListener('change', renderChats);

$('search').addEventListener('input', render);
$('only-online').addEventListener('change', render);
load();
setInterval(load, 5000);
setInterval(renderUpdated, 1000);

// Уведомление всем: приходит каждому в чат «Тайник»
$('notice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('notice-text').value.trim();
  $('notice-error').textContent = '';
  if (!text) return;
  if (!confirm('Отправить это сообщение всем пользователям?')) return;
  try {
    await act('notice', { name: '', text });
    $('notice-text').value = '';
    $('notice-error').className = 'muted small';
    $('notice-error').textContent = 'Отправлено';
  } catch (err) {
    $('notice-error').className = 'error small';
    $('notice-error').textContent = err.message;
  }
});

// Канал обновлений: пост от имени канала
$('news-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('news-text').value.trim();
  if (!text) return;
  if (!confirm('Опубликовать пост в канале обновлений? Его увидят все подписчики.')) return;
  try {
    await act('news', { text });
    $('news-text').value = '';
    $('news-status').className = 'muted small';
    $('news-status').textContent = 'Опубликовано';
  } catch (err) {
    $('news-status').className = 'error small';
    $('news-status').textContent = err.message;
  }
});
