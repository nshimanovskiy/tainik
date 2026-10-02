# Tainik

**End-to-end encrypted messenger for the web and desktop, with zero runtime dependencies.**

[Русская версия](README.ru.md) · [Releases](../../releases) · [Self-hosting guide](DEPLOY.md)

Tainik ("hideaway" in Russian) is a small, self-hostable messenger built on the Signal protocol design: **X3DH** key agreement and the **Double Ratchet**. Messages are encrypted on your device; the server only relays ciphertext and never sees what you write.

- 🔐 **End-to-end encryption.** X3DH + Double Ratchet, with forward secrecy and post-compromise security.
- 💻 **Web and desktop.** Runs in the browser and as a native app for Windows, macOS and Linux (Electron). Both share one UI and one crypto core.
- 📞 **Voice & video calls with screen sharing.** WebRTC media (DTLS-SRTP) whose connection setup travels over the Double Ratchet channel, so the server cannot man-in-the-middle a call. Rings all your devices; an optional self-hosted TURN relay helps behind NAT.
- 💬 **Telegram-style replies and deletion.** Quote-replies, "delete for me" (synced to all your devices) and "delete for everyone".
- 🟢 **Online status.** "online" / "last seen …" with live updates; you can hide your own status.
- 📱 **Multiple devices.** Up to 5 devices per account. Link a new one by scanning a QR code; sent messages sync across your devices.
- ✅ **Key verification.** A 60-digit safety number, plus a warning that blocks sending if a contact's key changes.
- 📦 **Zero dependencies.** Plain Node.js and the standard WebCrypto API. The server uses Node's built-in SQLite.
- 🐳 **Easy self-hosting.** Docker image, nginx/Caddy templates, one-command setup and daily backups.

> ⚠️ **Status: prototype.** The protocol is an independent implementation of the Signal specifications. It is covered by tests but **has not been audited**. Do not rely on it for high-risk communication yet. See [Limitations](#limitations).

## Download

Grab the latest installer from **[Releases](../../releases)**:

| Platform | File |
|---|---|
| Windows 10/11 | `Tainik-x.y.z-win-x64.exe` |
| macOS (Apple Silicon) | `Tainik-x.y.z-mac-arm64.dmg` |
| macOS (Intel) | `Tainik-x.y.z-mac-x64.dmg` |
| Linux | `Tainik-x.y.z-linux-x86_64.AppImage` or `.deb` |

Builds are not code-signed yet. Windows SmartScreen and macOS Gatekeeper will warn on first launch, and the release notes explain how to proceed. Verify downloads against `SHA256SUMS.txt`.

## Quick start (local)

```bash
node --version   # Node.js 22.13+ is required (built-in SQLite)
npm start        # server + web client at http://localhost:8080
npm test         # 22 tests: protocol, client↔server, multi-device, server, desktop
```

To try it alone, open `http://localhost:8080` in a normal window and in a private window, register two names, and add each other as contacts.

> Browsers expose WebCrypto only in secure contexts, so use `https://` or `localhost`.

### Desktop app from source

```bash
cd desktop
npm install      # Electron + electron-builder
npm start        # run the app
npm run dist     # build an installer for the current OS → desktop/dist/
```

On first launch, enter your server address (`chat.example.com` or `ws://localhost:8080/ws`). To bake in a default server, run `TAINIK_SERVER=chat.example.com npm run dist`.

## Self-hosting

On a VPS that already has Docker and nginx:

```bash
sudo ./deploy/setup.sh chat.example.com you@example.com
```

The script runs the server on `127.0.0.1`, adds an nginx site with WebSocket support, obtains a Let's Encrypt certificate via certbot, and schedules daily backups. It does not touch your firewall or other sites. See **[DEPLOY.md](DEPLOY.md)** for manual setup, a Caddy-only variant, a systemd variant, backups and troubleshooting.

**Updates from GitHub:** run `sudo ./deploy/connect-github.sh OWNER/REPO` once (read-only deploy key, plus an Actions key restricted to the update script), then update with **Actions → «Деплой сервера»**.

**Calls:** to make calls work across NATs, enable the bundled TURN relay with `sudo ./deploy/setup-calls.sh` (coturn, short-lived HMAC credentials, relaying to private networks blocked). The relay forwards only encrypted media.

**What the server stores:** usernames, public keys, and **encrypted** messages waiting for offline devices. Those messages are deleted after delivery, or after 30 days. Logs contain no usernames, IPs or content. The server **can** see metadata: who talks to whom, and when.

## How it works

| Component | Design |
|---|---|
| Identity | X25519 (key agreement) + Ed25519 (signatures). Two key pairs instead of XEdDSA; both are bound into the session AD and the safety number. |
| Prekeys | A signed prekey (rotated weekly, kept for 30 more days) and 100 one-time prekeys per device. The server hands out each one-time prekey only once, and clients refill below 20. |
| X3DH | Start a conversation while the recipient is offline. `SK = HKDF(F ‖ DH1 ‖ DH2 ‖ DH3 ‖ DH4)`, with the signed prekey signature verified. |
| Double Ratchet | A fresh key per message and a DH ratchet step per turn. Handles out-of-order and lost messages (up to 1000 skipped per chain). |
| Devices | Sessions are per device pair (`alice.1 ↔ bob.2`). Each message is encrypted separately for every recipient device and copied to your other devices. The server checks device lists on every send, and clients self-heal on mismatch. |
| Cipher | AES-256-GCM. The AAD binds the session AD, ratchet header, version, sender and recipient devices, and message id. Plaintext is padded to 64-byte blocks. |
| Auth | Passwordless: the client signs a server nonce with its Ed25519 identity key. |
| Device linking | The new device shows a QR code or a 64-character code containing a one-time X25519 key. The code is transferred out-of-band, so the server cannot read or swap the keys inside the encrypted provisioning payload. Codes are single-use and valid for 10 minutes. |
| Calls | WebRTC 1:1 with three fixed transceivers (audio, camera, screen), so turning the camera or screen share on or off needs no renegotiation. The SDP (including the DTLS fingerprint) is sent as ephemeral Double Ratchet messages that are never queued or stored. Mute and hang-up signals travel over a DTLS data channel. TURN credentials are HMAC-based, expire after 12 h and contain no username. |
| Local storage | **Desktop:** one file encrypted by the OS keystore (DPAPI / Keychain / libsecret) through Electron `safeStorage`. **Web:** IndexedDB, encrypted with a non-extractable AES-GCM key. |

**Desktop hardening:** `contextIsolation` and `sandbox` are on and the UI has no Node.js access. The UI is loaded from the app bundle over `app://`, never from the server, so a compromised server cannot inject JavaScript into the desktop app. The app also enforces a strict CSP, single-instance lock, blocked navigation and new windows, and Electron fuses (`runAsNode` off, asar integrity checks).

**Tested properties:** forward secrecy and replay rejection; post-compromise recovery; tampering with ciphertext, headers and ids; forged signed prekeys; server-side key substitution; simultaneous session initiation; out-of-order and lost delivery; no plaintext on the server's disk; per-device isolation; device linking with bad, foreign, expired or tampered codes; sent-message sync; unlinking; per-IP rate limits; data persistence across restarts. The built-in QR encoder is verified against OpenCV's decoder for versions 1–10.

### Moving to libsignal

`shared/protocol/session.js` mirrors libsignal's `SessionBuilder` / `SessionCipher` and its six-method store interface. To switch to [`@signalapp/libsignal-client`](https://github.com/signalapp/libsignal) (AGPL-3.0), you only need to reimplement that file. The UI and server stay unchanged.

## Project structure

```
shared/              Code shared by every platform
  protocol/          X3DH, Double Ratchet, sessions, safety numbers, device provisioning
  client-core.js     Platform-independent client logic
  qr.js              Dependency-free QR encoder
client/              UI (shared by web and desktop)
desktop/             Electron shell: secure storage, app:// protocol, packaging
server/              Relay server: WebSocket (RFC 6455), SQLite store, backups
deploy/              setup / backup / update scripts, nginx, Caddy and systemd templates
tests/               node:test suites
.github/workflows/   CI and desktop release pipeline
```

## Releasing

Run **Actions → «Выпуск десктопа» → Run workflow** with a version, or push a `vX.Y.Z` tag. CI runs the tests, builds installers for all three platforms and creates a draft release with checksums. See [RELEASING.md](RELEASING.md).

## Limitations

1. **Not audited.** The protocol is a from-spec implementation, not libsignal.
2. **Unlinking does not revoke the identity key.** A stolen device stops receiving messages, but its identity key could still be used to link a new device. If a device is stolen, create a new account.
3. **The web client is served by the server**, so a compromised server could ship modified JavaScript. Use the desktop app for stronger guarantees.
4. **Metadata** (who, to whom, when, and online status unless hidden) is visible to the server. During calls, peers see each other's IP addresses unless traffic goes through TURN.
5. No group calls, groups, attachments, push notifications or key backup yet. Message history is not transferred to newly linked devices.

## Roadmap

- History transfer to new devices; sync of read and verified state
- Mobile apps (React Native + `react-native-quick-crypto`), reusing `shared/` as is
- Groups (MLS) and attachments

## License

[MIT](LICENSE)
