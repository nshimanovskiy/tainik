// Адаптер хранилища для браузера: IndexedDB с шифрованием «на диске».
// Все значения (ключи протокола, сессии, переписка) шифруются AES-256-GCM.
// Мастер-ключ — неизвлекаемый CryptoKey: браузер хранит его в IndexedDB, но
// прочитать его байты нельзя даже из JavaScript этой страницы.
const MASTER = '__master_key__';

export class IdbStorage {
  constructor(name = 'tainik-v2') {
    this.ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.key = this.ready.then(() => this._masterKey());
  }

  async _tx(mode, fn) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async _masterKey() {
    let k = await this._tx('readonly', (s) => s.get(MASTER));
    if (!k) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await this._tx('readwrite', (s) => s.put(k, MASTER));
    }
    return k;
  }

  async get(k) {
    const rec = await this._tx('readonly', (s) => s.get(k));
    if (!rec) return undefined;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: rec.iv, additionalData: new TextEncoder().encode(k) },
      await this.key,
      rec.ct
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async set(k, v) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(k) },
      await this.key,
      new TextEncoder().encode(JSON.stringify(v))
    );
    await this._tx('readwrite', (s) => s.put({ iv, ct }, k));
  }

  del(k) {
    return this._tx('readwrite', (s) => s.delete(k));
  }

  /** Стирает данные, но оставляет мастер-ключ (новый аккаунт зашифруется им же). */
  async clear() {
    const key = await this.key;
    await this._tx('readwrite', (s) => {
      s.clear();
      return s.put(key, MASTER);
    });
  }
}

/** Хранилище настроек без шифрования (адрес сервера). */
export const settings = {
  get: (k) => {
    try {
      return localStorage.getItem('tainik:' + k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem('tainik:' + k, v);
    } catch {}
  },
};
