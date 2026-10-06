// Платная подписка «Тайник Премиум» с оплатой криптовалютой через xRocket Pay
// (https://docs.xrocket.exchange/api/pay/pay-api-overview).
//
// Как это работает:
//   1. Клиент просит счёт (WS premium-buy) → сервер создаёт инвойс POST /api/v1/invoices
//      с нашим clientInvoiceId и отдаёт ссылку на оплату в @xRocket.
//   2. Пользователь платит в Telegram → xRocket присылает подписанный вебхук на
//      /api/pay/xrocket → сервер проверяет подпись и продлевает подписку.
//   3. Если вебхук потерялся (сервер лежал, неверный адрес), подписку подтянет опрос:
//      кнопка «Проверить оплату» и фоновая сверка неоплаченных счетов.
//
// В xRocket уходит только сумма, валюта, описание тарифа и наш случайный id счёта —
// юзернейм пользователя туда не передаётся. Продление идемпотентно: один счёт продлевает
// подписку ровно один раз, сколько бы уведомлений ни пришло.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const XROCKET_API = 'https://pay.api.xrocket.exchange';
export const XROCKET_TESTNET_API = 'https://pay.api.testnet.xrocket.exchange';
export const WEBHOOK_PATH = '/api/pay/xrocket';
const INVOICE_TTL = 60 * 60_000; // счёт действует час
const REUSE_MIN = 10 * 60_000; // уже выставленный счёт отдаём повторно, если ему жить ещё 10+ минут
const SIGNATURE_TOLERANCE = 5 * 60_000; // окно против повтора старых вебхуков
const MAX_WEBHOOK_BODY = 64 * 1024;
const DECIMAL_RE = /^\d{1,12}(\.\d{1,8})?$/;
const CURRENCY_RE = /^[A-Z0-9]{2,12}$/;

/**
 * Тарифы из строки «дни:цена,…», например "30:3,90:8,365:30". Цена — десятичная строка
 * в валюте currency (как в API xRocket: суммы — строки, без плавающей точки).
 */
export function parsePlans(spec, currency = 'USDT') {
  currency = String(currency || 'USDT').trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) throw new Error(`PREMIUM_CURRENCY: неверный код валюты «${currency}»`);
  const plans = [];
  for (const part of String(spec || '30:3').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,4})\s*:\s*(\S+)$/.exec(part);
    if (!m || !DECIMAL_RE.test(m[2]) || Number(m[1]) < 1 || Number(m[2]) <= 0) {
      throw new Error(`PREMIUM_PLANS: «${part}» — нужно «дни:цена», например 30:3`);
    }
    const days = Number(m[1]);
    if (plans.some((p) => p.days === days)) throw new Error(`PREMIUM_PLANS: тариф на ${days} дн. указан дважды`);
    plans.push({ id: `${days}d`, days, price: m[2], currency });
  }
  if (!plans.length) throw new Error('PREMIUM_PLANS: нет ни одного тарифа');
  return plans.sort((a, b) => a.days - b.days);
}

/**
 * Пакеты монет из строки «монеты:цена,…», например "100:1,550:5,1200:10" (цена — в валюте
 * тарифов). Монеты — внутренняя валюта: ими платят за Премиум, позже — за подарки.
 */
export function parsePacks(spec, currency = 'USDT') {
  currency = String(currency || 'USDT').trim().toUpperCase();
  const packs = [];
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,7})\s*:\s*(\S+)$/.exec(part);
    if (!m || !DECIMAL_RE.test(m[2]) || Number(m[1]) < 1 || Number(m[2]) <= 0) {
      throw new Error(`COIN_PACKS: «${part}» — нужно «монеты:цена», например 100:1`);
    }
    const coins = Number(m[1]);
    if (packs.some((p) => p.coins === coins)) throw new Error(`COIN_PACKS: пакет на ${coins} монет указан дважды`);
    packs.push({ id: `${coins}c`, coins, price: m[2], currency });
  }
  return packs.sort((a, b) => a.coins - b.coins);
}

/** Цена тарифа в монетах: цена × монет за единицу валюты, с округлением вверх. */
export function coinPrice(price, perUnit) {
  return Math.max(1, Math.ceil(Number((Number(price) * perUnit).toPrecision(12))));
}

/**
 * Валюты, которыми можно оплатить: «USDT,GRAM,TRX». Первая — основная, в ней заданы цены
 * тарифов; в остальных сумма считается по курсу xRocket в момент выставления счёта.
 */
export function parseCurrencies(spec, base) {
  const list = [base];
  for (const c of String(spec || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    if (!CURRENCY_RE.test(c)) throw new Error(`PREMIUM_PAY_CURRENCIES: неверный код валюты «${c}»`);
    if (!list.includes(c)) list.push(c);
  }
  return list;
}

/** price / rate, округлено ВВЕРХ до 4 значащих цифр (но не меньше 2 и не больше 8 знаков после точки). */
export function convertPrice(price, rate) {
  const x = Number(price) / Number(rate);
  if (!Number.isFinite(x) || x <= 0) return null;
  const decimals = Math.max(2, Math.min(8, 3 - Math.floor(Math.log10(x))));
  const k = 10 ** decimals;
  const up = Math.ceil(Number((x * k).toPrecision(12))) / k;
  return up.toFixed(decimals).replace(/\.?0+$/, '');
}

/** Одинаковые ли две десятичные суммы ("3" и "3.00" — да). */
export function sameAmount(a, b) {
  const norm = (x) => {
    const s = String(x ?? '').trim();
    if (!DECIMAL_RE.test(s)) return null;
    const [i, f = ''] = s.split('.');
    return `${BigInt(i)}.${f.replace(/0+$/, '')}`;
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

/**
 * Подпись вебхука xRocket Pay (схема v1): hex(HMAC-SHA256(secret, "{timestamp}.{raw body}")),
 * timestamp — в миллисекундах. Проверяется по сырым байтам тела, до разбора JSON.
 */
export function verifyWebhookSignature({ secret, rawBody, signature, version, timestamp, now = Date.now(), tolerance = SIGNATURE_TOLERANCE }) {
  if (!secret || !signature || !timestamp || version !== 'v1') return false;
  if (!/^\d{10,16}$/.test(String(timestamp)) || Math.abs(now - Number(timestamp)) > tolerance) return false;
  if (!/^[0-9a-f]{64}$/i.test(String(signature))) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
  const got = Buffer.from(String(signature), 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Подписать тело так же, как xRocket (для тестов и ручной проверки). */
export function signWebhook(secret, rawBody, timestamp = Date.now()) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export class BillingError extends Error {
  /** code — наш или xRocket-код ошибки; text — пояснение xRocket (для журнала и пользователя). */
  constructor(code, detail, text = '') {
    super(code);
    this.code = code;
    this.detail = detail;
    this.text = String(text || '').slice(0, 200);
  }
}

// Одна и та же монета в xRocket может называться по-разному (TON = TONCOIN)
const ALIASES = { TON: ['TONCOIN'], TONCOIN: ['TON'], GRAM: ['GRAMCOIN'], TRX: ['TRON'] };

/**
 * @param {object} o
 * @param {import('./store.js').Store} o.store
 * @param {string}   o.token          Bearer-токен приложения xRocket Pay (API Token)
 * @param {string}  [o.webhookSecret] Webhook Token — без него вебхуки не принимаются, работает только опрос
 * @param {boolean} [o.testnet]       тестовая сеть xRocket (бот @xrocket_testnet_bot)
 * @param {string}  [o.apiUrl]        свой адрес API (для тестов)
 * @param {Array}   [o.plans]         из parsePlans()
 * @param {string[]}[o.currencies]    из parseCurrencies(): первая — валюта цен тарифов
 * @param {Array}   [o.packs]         из parsePacks(): пакеты монет за криптовалюту ([] — монеты не продаются)
 * @param {number}  [o.coinsPerUnit]  монет за 1 единицу валюты тарифов — по нему цена Премиума в монетах (0 — нельзя)
 * @param {string}  [o.publicUrl]     https://домен — тогда адрес вебхука передаётся в каждом счёте
 * @param {Function}[o.fetch]
 * @param {Function}[o.onPaid]        ({ user, until, gift, coins }) — оплачено: подписка продлена (gift — если подарок)
 *                                   или монеты зачислены (coins — новый баланс)
 */
export function createBilling({ store, token, webhookSecret = null, testnet = false, apiUrl = null, plans = parsePlans(), currencies = null, packs = [], coinsPerUnit = 100, publicUrl = null, fetch: fetchImpl = globalThis.fetch, onPaid = () => {}, say = () => {} }) {
  if (!token) return null;
  const apiBase = String(apiUrl || (testnet ? XROCKET_TESTNET_API : XROCKET_API)).replace(/\/+$/, '');
  const callbackUrl = publicUrl && webhookSecret ? `${String(publicUrl).replace(/\/+$/, '')}${WEBHOOK_PATH}` : null;
  const checking = new Set(); // счета, которые сейчас сверяются (чтобы не опрашивать дважды)
  const base = plans[0].currency;
  // Цена тарифа в монетах — для оплаты Премиума с баланса
  plans = plans.map((p) => (coinsPerUnit > 0 ? { ...p, coins: coinPrice(p.price, coinsPerUnit) } : p));
  let payWith = currencies?.length ? currencies : [base];
  const rates = new Map(); // валюта → { rate, at }: сколько основной валюты стоит единица валюты

  /** Курс: сколько основной валюты (base) стоит 1 единица currency. Кэш на 2 минуты. */
  async function rateOf(currency) {
    const c = rates.get(currency);
    if (c && Date.now() - c.at < 120_000) return c.rate;
    const pick = (list, code) => Number((Array.isArray(list) ? list : []).find((x) => String(x?.currency).toUpperCase() === code)?.rate);
    let rate = NaN;
    try {
      rate = pick(await api('GET', '/api/v1/rates', { query: { base, assets: currency } }), currency);
    } catch (e) {
      say(`оплата: курс ${currency} к ${base} не получен — ${e.code}${e.text ? ': ' + e.text : ''}`);
    }
    // base у курсов — фиатная валюта: если основная валюта не фиат (USDT), считаем через USD
    if (!(rate > 0) && base !== 'USD') {
      try {
        const q = new URL('http://x');
        q.searchParams.append('assets', base);
        q.searchParams.append('assets', currency);
        const list = await api('GET', '/api/v1/rates?' + q.searchParams, { query: { base: 'USD' } });
        rate = pick(list, currency) / pick(list, base);
      } catch (e) {
        say(`оплата: курс ${currency} к USD не получен — ${e.code}${e.text ? ': ' + e.text : ''}`);
      }
    }
    if (!(rate > 0) || !Number.isFinite(rate)) throw new BillingError('no_rate', currency);
    say(`оплата: курс 1 ${currency} = ${rate} ${base}`);
    rates.set(currency, { rate, at: Date.now() });
    return rate;
  }

  // Каких валют из списка нет в xRocket — убираем (с записью в журнал), чтобы не показывать их людям
  async function checkCurrencies() {
    if (payWith.length < 2) return;
    try {
      const list = await api('GET', '/api/v1/currencies');
      const known = new Set((Array.isArray(list) ? list : []).map((c) => String(c?.code || '').toUpperCase()));
      if (!known.size) return;
      say(`оплата: валюты xRocket — ${[...known].join(', ')}`);
      // Если валюта называется в xRocket иначе (TON → TONCOIN) — берём его код
      payWith = payWith.map((c) => (known.has(c) ? c : (ALIASES[c] || []).find((a) => known.has(a)) || c));
      payWith = [...new Set(payWith)];
      const missing = payWith.filter((c) => c !== base && !known.has(c));
      if (missing.length) {
        say(`оплата: валют ${missing.join(', ')} нет в xRocket — они не предлагаются`);
        payWith = payWith.filter((c) => !missing.includes(c));
      }
    } catch {}
  }
  checkCurrencies();

  async function api(method, path, { query, body } = {}) {
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    let r;
    try {
      r = await fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new BillingError('billing_unavailable', e?.cause?.code || e?.name || e?.message);
    }
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!r.ok) {
      // Ошибки — RFC 9457: ветвимся по type (/api/problems/<code>), detail — только для людей
      const code = typeof data?.type === 'string' ? data.type.split('/').pop() : `http_${r.status}`;
      throw new BillingError(code, data?.instance || r.status, data?.detail || data?.title || '');
    }
    return data;
  }

  /** Счёт из ответа xRocket применить к нашей записи. Возвращает итог или null. */
  function apply(pay, inv) {
    if (!pay || !inv || typeof inv !== 'object') return null;
    if (pay.invoiceId && inv.id && String(inv.id) !== pay.invoiceId) return null; // не тот счёт
    if (inv.status === 'paid') {
      // Защита от подмены: сумма и валюта должны совпасть с выставленными
      if (inv.priceCurrency !== pay.currency || !sameAmount(inv.priceAmount, pay.amount)) {
        say('оплата: сумма или валюта счёта не совпадает — не засчитана');
        return null;
      }
      const res = store.markPaymentPaid(pay.id);
      if (res) {
        say(res.coins != null ? 'оплата: монеты зачислены' : 'оплата: подписка продлена');
        if (res.until || res.coins != null) onPaid(res);
      }
      return res;
    }
    if (inv.status === 'expired' || inv.status === 'cancelled') store.closePayment(pay.id, inv.status);
    return null;
  }

  /** Сверить один наш счёт с xRocket. */
  async function checkPayment(pay) {
    if (checking.has(pay.id)) return null;
    checking.add(pay.id);
    try {
      const inv = await api('GET', '/api/v1/invoice', { query: { clientInvoiceId: pay.id } });
      return apply(pay, inv);
    } catch (e) {
      // Счёта у xRocket нет (выставить не удалось): закрываем, но не тот, что выставляется прямо сейчас
      if ((e.code === 'not_found' || e.code === 'invoice_not_found') && Date.now() - pay.createdAt > 2 * 60_000) store.closePayment(pay.id, 'failed');
      else say('оплата: сверка не удалась', e.code);
      return null;
    } finally {
      checking.delete(pay.id);
    }
  }

  return {
    plans,
    packs,
    get currencies() {
      return payWith;
    },
    testnet: !!testnet,
    webhook: !!webhookSecret,

    /**
     * Счёт на оплату тарифа в выбранной валюте: { id, url, days, price, currency, expiresAt, giftTo }.
     * giftTo — юзернейм получателя подарка (проверяет вызывающий); платит user.
     */
    async createInvoice(user, planId, currency = base, giftTo = null) {
      // Тариф Премиума или пакет монет (монеты не дарятся)
      const plan = plans.find((p) => p.id === planId) || (!giftTo && packs.find((p) => p.id === planId));
      if (!plan) throw new BillingError('bad_plan');
      currency = String(currency || base).toUpperCase();
      if (!payWith.includes(currency)) throw new BillingError('bad_currency');
      const now = Date.now();
      giftTo = giftTo || null;
      const open = store.openPayment(user, plan.id, currency, now + REUSE_MIN, giftTo);
      if (open?.url) return { id: open.id, url: open.url, days: open.days, coins: open.coins, price: open.amount, currency: open.currency, expiresAt: open.expiresAt, giftTo };

      // Цена в другой валюте — по текущему курсу xRocket, с округлением вверх
      const amount = currency === base ? plan.price : convertPrice(plan.price, await rateOf(currency));
      if (!amount) throw new BillingError('no_rate', currency);
      const id = 'tk' + randomBytes(12).toString('hex');
      store.addPayment({ id, user, plan: plan.id, days: plan.days || 0, amount, currency, expiresAt: now + INVOICE_TTL, giftTo, coins: plan.coins && !plan.days ? plan.coins : null, now });
      const body = {
        priceAmount: amount,
        priceCurrency: currency,
        numPayments: 1,
        clientInvoiceId: id,
        description: plan.days ? `Тайник Премиум — ${plan.days} дн.${giftTo ? ' (подарок)' : ''}` : `Тайник — ${plan.coins} монет`, // без юзернеймов
        expiresIn: INVOICE_TTL,
      };
      if (callbackUrl) body.callback = { callbackUrl };
      let inv;
      try {
        inv = await api('POST', '/api/v1/invoices', { body });
      } catch (e) {
        // Повтор с тем же clientInvoiceId: счёт уже создан — берём его
        if (e.code === 'client_id_already_taken') inv = await api('GET', '/api/v1/invoice', { query: { clientInvoiceId: id } }).catch(() => null);
        if (!inv) {
          store.closePayment(id, 'failed');
          say(`оплата: xRocket не выставил счёт (${amount} ${currency}) — ${e.code}${e.text ? ': ' + e.text : ''}`);
          throw e instanceof BillingError ? new BillingError('billing_failed', e.code, e.text) : e;
        }
      }
      const url = inv?.links?.telegramBotLink;
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
        store.closePayment(id, 'failed');
        throw new BillingError('billing_failed', 'no_link');
      }
      const expiresAt = inv.expiresAt ? Date.parse(inv.expiresAt) || now + INVOICE_TTL : now + INVOICE_TTL;
      store.setPaymentInvoice(id, inv.id != null ? String(inv.id) : null, url, expiresAt);
      return { id, url, days: plan.days || 0, coins: plan.days ? null : plan.coins, price: amount, currency, expiresAt, giftTo };
    },

    /** «Проверить оплату»: сверить неоплаченные счета пользователя. */
    async check(user) {
      for (const pay of store.pendingPayments(user, Date.now() - 10 * 60_000, 5)) await checkPayment(pay);
    },

    /** Фоновая сверка: несколько самых старых неоплаченных счетов (лимит API — 20 запросов в минуту). */
    async reconcile(limit = 8) {
      for (const pay of store.pendingPayments(null, Date.now() - 10 * 60_000, limit)) await checkPayment(pay);
    },

    /** Вебхук xRocket Pay. true — запрос обработан здесь. */
    handleHttp(req, res) {
      if (new URL(req.url, 'http://x').pathname !== WEBHOOK_PATH) return false;
      const reply = (status, text = '') => res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(text);
      if (!webhookSecret) return reply(404), true;
      if (req.method !== 'POST') return reply(405), true;
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_WEBHOOK_BODY) {
          reply(413);
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (size > MAX_WEBHOOK_BODY) return;
        const raw = Buffer.concat(chunks);
        const ok = verifyWebhookSignature({
          secret: webhookSecret,
          rawBody: raw,
          signature: req.headers['signature'],
          version: req.headers['signature-version'],
          timestamp: req.headers['signature-timestamp'],
        });
        if (!ok) {
          say('оплата: вебхук с неверной подписью отклонён');
          return reply(401, 'invalid signature');
        }
        let event;
        try {
          event = JSON.parse(raw.toString('utf8'));
        } catch {
          return reply(200); // подпись верна, но разобрать нельзя — повторять бессмысленно
        }
        // Неизвестные типы и события — просто подтверждаем
        const inv = event?.type === 'invoice' ? event.data?.invoice : null;
        if (inv && typeof inv.clientInvoiceId === 'string') {
          const pay = store.getPayment(inv.clientInvoiceId);
          if (pay && pay.status !== 'paid') {
            // payment_status_changed несёт усечённый invoice — за полным счётом сходим сами
            if (event.data.event === 'invoice_status_changed' && inv.priceAmount != null) apply(pay, inv);
            else if (inv.status === 'paid') checkPayment(pay).catch(() => {});
          }
        }
        reply(200);
      });
      req.on('error', () => {});
      return true;
    },
  };
}
