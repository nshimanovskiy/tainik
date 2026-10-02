// Профиль iOS с веб-клипом: значок Тайника на экране «Домой» iPhone и iPad.
// Так же ставятся «приложения-закладки» VK и MAX: Safari скачивает профиль,
// пользователь подтверждает его в Настройках — и появляется значок. Открывается
// он как отдельное приложение (без панелей Safari), со своим хранилищем и Web Push.
// Профиль ничего не разрешает на телефоне: в нём только адрес, название и значок.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HOST_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Постоянный UUID из строки: переустановка профиля заменяет старый, а не добавляет второй. */
function stableUuid(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

/** Адрес сервера для профиля: DOMAIN из настроек или заголовок Host запроса. */
export function webclipHost(req, domain) {
  const host = String(domain || req.headers.host || '').trim().toLowerCase();
  return HOST_RE.test(host) ? host : null;
}

export function buildWebclip({ host, icon, name = 'Тайник' }) {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const url = `${local ? 'http' : 'https'}://${host}/`;
  const bare = host.replace(/:\d+$/, '');
  const id = bare.split('.').reverse().join('.') + '.tainik';
  const b64 = icon.toString('base64').replace(/.{1,64}/g, '$&\n\t\t\t');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>FullScreen</key>
			<true/>
			<key>Icon</key>
			<data>
			${b64}</data>
			<key>IsRemovable</key>
			<true/>
			<key>Label</key>
			<string>${xml(name)}</string>
			<key>Precomposed</key>
			<true/>
			<key>URL</key>
			<string>${xml(url)}</string>
			<key>PayloadDisplayName</key>
			<string>${xml(name)}</string>
			<key>PayloadIdentifier</key>
			<string>${xml(id)}.webclip</string>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadUUID</key>
			<string>${stableUuid(url + '|webclip')}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>${xml(`Добавляет значок мессенджера «${name}» (${bare}) на экран «Домой». Профиль не даёт доступа к телефону и данным — в нём только адрес, название и значок. Удалить: Настройки → Основные → VPN и управление устройством.`)}</string>
	<key>PayloadDisplayName</key>
	<string>${xml(name)}</string>
	<key>PayloadIdentifier</key>
	<string>${xml(id)}</string>
	<key>PayloadOrganization</key>
	<string>${xml(bare)}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${stableUuid(url + '|profile')}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

export function createWebclipHandler({ root, domain }) {
  const iconFile = path.join(root, 'client', 'apple-touch-icon.png');
  let icon = null;
  return function handleWebclip(req, res) {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/ios' || p === '/iphone') {
      req.url = '/ios.html'; // страница установки — обычная статика
      return false;
    }
    if (p !== '/tainik.mobileconfig') return false;
    const host = webclipHost(req, domain);
    if (!host) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Неизвестный адрес сервера');
      return true;
    }
    icon ||= fs.readFileSync(iconFile);
    const body = buildWebclip({ host, icon });
    res.writeHead(200, {
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Disposition': 'attachment; filename="Tainik.mobileconfig"',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
