// Звонки 1:1 на WebRTC: голос, видео и трансляция экрана.
//
// Безопасность. Медиапоток шифруется DTLS-SRTP напрямую между устройствами.
// Описание соединения (SDP, в нём отпечаток DTLS-сертификата) передаётся
// через уже установленный канал X3DH + Double Ratchet, поэтому сервер не может
// подменить отпечаток и встать посередине. TURN-сервер, если он понадобится,
// пересылает только зашифрованные SRTP-пакеты.
//
// Устройство соединения: три фиксированных трансивера — звук, камера, экран —
// создаются сразу. Камеру и экран включают и выключают через replaceTrack(),
// без повторного согласования SDP. Состояние (микрофон/камера/экран) и
// завершение звонка передаются по DataChannel (тоже DTLS).
//
// Групповой звонок — сеть «каждый с каждым»: с каждым участником своё такое же соединение.
// Сигналы (kind в { t: 'gcall' }) идут по парным E2E-сессиям участникам группы:
//   ring  — начали звонок (всем устройствам участников), у остальных звонит;
//   join  — присоединился (всем устройствам): каждый, кто уже в звонке, шлёт ему offer;
//   offer/answer — описание соединения пары (только нужному устройству);
//   alive — раз в ALIVE_EVERY старший участник напоминает тем, кто в сети, что звонок идёт и кто в нём;
//   leave — вышел.
// Сервер не участвует в звонке и не видит, кто с кем разговаривает, — только сами мгновенные сообщения.
import { t } from '/shared/i18n.js';

const RING_TIMEOUT = 45_000;
const ICE_GATHER_TIMEOUT = 4_000;
const DISCONNECT_GRACE = 10_000;
const SCREEN_MAX_BITRATE = 3_000_000;
const SCREEN_MAX_WIDTH = 1920;
const SCREEN_MAX_HEIGHT = 1080;

// Групповые звонки: каждый отправляет свой поток каждому, поэтому участников немного
export const GROUP_CALL_MAX = 8;
const ALIVE_EVERY = 25_000;
const ROSTER_TTL = 70_000;
const ALONE_TIMEOUT = 60_000; // все вышли — через минуту звонок завершается
const OFFER_TIMEOUT = 30_000;
const SPEAK_LEVEL = 0.04; // громкость, с которой участник «говорит» (0…1)
const SPEAK_HOLD = 500;
const ADDR_RE = /^[a-z0-9_]{3,32}:[1-9]\d{0,8}$/;
const CALL_ID_RE = /^[0-9a-f]{8,40}$/;
const addrOf = (name, device) => `${name}:${device}`;
const VC_RE = /^[0-9a-f]{8}$/;
/** Ключ списка участников: звонок группы — сам чат, голосовой канал сообщества — чат/канал. */
const rosterKey = (chat, vc) => (vc ? `${chat}/${vc}` : chat);

const T_AUDIO = 0;
const T_CAM = 1;
const T_SCREEN = 2;

const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

function waitIceGathering(pc, ms = ICE_GATHER_TIMEOUT) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCand);
      resolve();
    };
    const onState = () => pc.iceGatheringState === 'complete' && done();
    const onCand = (e) => !e.candidate && done();
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCand);
  });
}

// ---------- Звуки звонка (генерируются WebAudio, без файлов) ----------
class Tones {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.sink = ''; // устройство вывода ('' — системное по умолчанию)
  }
  /** Гудки — в выбранное устройство вывода (где браузер это умеет). */
  setSink(id) {
    this.sink = id || '';
    this.ctx?.setSinkId?.(this.sink).catch(() => this.ctx?.setSinkId?.('').catch(() => {}));
  }
  _ctx() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      if (this.sink) this.ctx.setSinkId?.(this.sink).catch(() => {});
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }
  _beep(freqs, dur, gain = 0.08) {
    const ctx = this._ctx();
    if (!ctx) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.02);
    g.gain.setValueAtTime(gain, ctx.currentTime + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
    g.connect(ctx.destination);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start();
      o.stop(ctx.currentTime + dur);
    }
  }
  /** Гудки у звонящего: 425 Гц, 1 с звук / 3 с тишина. */
  ringback() {
    this.stop();
    const tick = () => this._beep([425], 1.0, 0.05);
    tick();
    this.timer = setInterval(tick, 4000);
  }
  /** Звонок у вызываемого: двойной сигнал каждые 3 с. */
  ring() {
    this.stop();
    const tick = () => {
      this._beep([660, 880], 0.35, 0.09);
      setTimeout(() => this._beep([660, 880], 0.35, 0.09), 450);
    };
    tick();
    this.timer = setInterval(tick, 3000);
  }
  end() {
    this.stop();
    this._beep([480], 0.25, 0.05);
    setTimeout(() => this._beep([380], 0.35, 0.05), 300);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

export const CALL_RESULT_TEXT = {
  answered: t('звонок'),
  missed: t('пропущенный звонок'),
  declined: t('отклонён'),
  busy: t('занято'),
  no_answer: t('нет ответа'),
  unavailable: t('собеседник не в сети'),
  failed: t('не удалось соединиться'),
  cancelled: t('отменён'),
  elsewhere: t('отвечен на другом устройстве'),
};

export class CallManager {
  /**
   * @param {object} o
   * @param {import('../shared/client-core.js').MessengerClient} o.client
   * @param {Function} [o.onChange]  вызывается при любом изменении состояния
   */
  constructor({ client, onChange = () => {}, onRoster = () => {} }) {
    this.client = client;
    this.onChange = onChange;
    this.onRoster = onRoster; // (chat) — изменился список идущих групповых звонков
    this.call = null;
    this.rosters = new Map(); // чат группы (или чат/голосовой канал) → { callId, video, from, parts: Map(адрес → { name, device }), seen }
    this.micId = ''; // выбранный микрофон ('' — системный по умолчанию)
    this.micGain = 1; // громкость своего голоса для собеседника: 0…2 (1 — как есть)
    this.tones = new Tones();
    client.on('call-signal', (s) => this._onSignal(s).catch((e) => console.error('call', e)));
    client.on('gcall-signal', (s) => this._onGroupSignal(s).catch((e) => console.error('gcall', e)));
    setInterval(() => this._expireRosters(), 5000);
  }

  get busy() {
    return !!this.call && this.call.phase !== 'ended';
  }

  _emit() {
    try {
      this.onChange(this.call);
    } catch (e) {
      console.error(e);
    }
  }

  _signal(kind, extra = {}, deviceIds) {
    const c = this.call;
    const opts = deviceIds ? { deviceIds } : {};
    if (kind === 'offer') opts.notify = 'call'; // никто не в сети — сервер пришлёт «пропущенный звонок» пушем
    return this.client.sendEphemeral(c.peer, { t: 'call', kind, callId: c.id, ts: Date.now(), ...extra }, opts);
  }

  // ---------- Исходящий звонок ----------

  async start(peer, { video = false } = {}) {
    if (this.busy) throw new Error(t('Уже идёт звонок'));
    if (String(peer).startsWith('#')) return this._startGroup(peer, video);
    const c = (this.call = this._newCall({ peer, role: 'caller', video, phase: 'preparing' }));
    this._emit();
    try {
      await this._getLocalMedia(video);
      await this._createPeer();
      const offer = await c.pc.createOffer();
      await c.pc.setLocalDescription(offer);
      await waitIceGathering(c.pc);
      if (this.call !== c) return; // отменили, пока готовились
      const delivered = await this._signal('offer', { sdp: c.pc.localDescription.sdp, video });
      if (this.call !== c) return;
      if (!delivered.length) return this._end('unavailable');
      c.ringingDevices = delivered;
      c.phase = 'outgoing';
      this.tones.ringback();
      c.ringTimer = setTimeout(() => this._cancelOutgoing('no_answer'), RING_TIMEOUT);
      this._emit();
    } catch (e) {
      if (this.call === c) this._end('failed', e);
      throw e;
    }
  }

  async _cancelOutgoing(result) {
    const c = this.call;
    if (!c || c.role !== 'caller' || (c.phase !== 'outgoing' && c.phase !== 'preparing')) return;
    const targets = c.ringingDevices || [];
    this._end(result);
    if (targets.length) this.client.sendEphemeral(c.peer, { t: 'call', kind: 'cancel', callId: c.id, ts: Date.now(), reason: result }, { deviceIds: targets }).catch(() => {});
  }

  // ---------- Входящий звонок ----------

  async accept({ video = false } = {}) {
    const c = this.call;
    if (!c || c.phase !== 'incoming') return;
    if (c.group) return this.joinGroup(c.peer, { video });
    this.tones.stop();
    clearTimeout(c.ringTimer);
    c.phase = 'connecting';
    c.video = video;
    this._emit();
    try {
      await this._getLocalMedia(video);
      await this._createPeer();
      await c.pc.setRemoteDescription({ type: 'offer', sdp: c.offerSdp });
      const trs = c.pc.getTransceivers();
      for (const tr of trs) tr.direction = 'sendrecv';
      await trs[T_AUDIO]?.sender.replaceTrack(this._sendTrack(c));
      await trs[T_CAM]?.sender.replaceTrack(c.local.cam || null);
      const answer = await c.pc.createAnswer();
      await c.pc.setLocalDescription(answer);
      await waitIceGathering(c.pc);
      if (this.call !== c) return;
      await this._signal('answer', { sdp: c.pc.localDescription.sdp }, [c.peerDevice]);
    } catch (e) {
      if (this.call === c) {
        this._signal('decline', { reason: 'failed' }, [c.peerDevice]).catch(() => {});
        this._end('failed', e);
      }
      throw e;
    }
  }

  decline() {
    const c = this.call;
    if (!c || c.phase !== 'incoming') return;
    if (c.group) return this._end('declined'); // в группе отказ никому не сообщается
    this._signal('decline', {}, [c.peerDevice]).catch(() => {});
    this._end('declined');
  }

  // ---------- Во время звонка ----------

  hangup() {
    const c = this.call;
    if (!c || c.phase === 'ended') return;
    if (c.phase === 'incoming') return this.decline();
    if (c.group) return this._leaveGroup();
    if (c.role === 'caller' && (c.phase === 'outgoing' || c.phase === 'preparing')) return this._cancelOutgoing('cancelled');
    this._sendCtl({ type: 'hangup' });
    if (c.peerDevice) this._signal('hangup', {}, [c.peerDevice]).catch(() => {});
    this._end(c.startedAt ? 'answered' : 'cancelled');
  }

  toggleMic() {
    const c = this.call;
    if (!c?.local.mic) return;
    c.local.mic.enabled = !c.local.mic.enabled;
    this._sendState();
    this._emit();
  }

  /**
   * Выбрать микрофон. Во время звонка — переключает на лету (replaceTrack, без
   * повторного согласования), сохраняя «выключен/включён».
   */
  async setMicrophone(id) {
    this.micId = id || '';
    const c = this.call;
    if (!c?.local.mic || c.phase === 'ended') return;
    const s = await navigator.mediaDevices.getUserMedia({ audio: this._audioConstraints() });
    const track = s.getAudioTracks()[0];
    if (this.call !== c || !track) return s.getTracks().forEach((tr) => tr.stop());
    const old = c.local.mic;
    track.enabled = old.enabled;
    if (c.micFx) {
      // Громкость уже регулируется: меняем только источник, отправляемая дорожка та же
      c.micFx.src.disconnect();
      c.micFx.src = c.micFx.ctx.createMediaStreamSource(new MediaStream([track]));
      c.micFx.src.connect(c.micFx.gain);
    } else {
      await this._replace(c, T_AUDIO, track);
    }
    c.local.mic = track;
    old.stop();
    this._emit();
  }

  /**
   * Громкость своего голоса для собеседника (0…2). Микрофон проходит через WebAudio:
   * усиление и ограничитель, чтобы громкий голос не хрипел. Пока громкость 100%,
   * обработки нет — отправляется сам микрофон.
   */
  async setMicGain(v) {
    this.micGain = Math.min(2, Math.max(0, Number(v) || 0));
    const c = this.call;
    if (!c?.local.mic || c.phase === 'ended') return;
    if (c.micFx) {
      c.micFx.gain.gain.value = this.micGain;
      return;
    }
    if (this.micGain === 1) return;
    const track = this._buildMicFx(c);
    if (track) await this._replace(c, T_AUDIO, track);
  }

  _buildMicFx(c) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC || !c.local.mic) return null;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(new MediaStream([c.local.mic]));
    const gain = ctx.createGain();
    gain.gain.value = this.micGain;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -6;
    limit.knee.value = 6;
    limit.ratio.value = 12;
    limit.attack.value = 0.003;
    limit.release.value = 0.25;
    const dest = ctx.createMediaStreamDestination();
    src.connect(gain).connect(limit).connect(dest);
    ctx.resume().catch(() => {});
    c.micFx = { ctx, src, gain, track: dest.stream.getAudioTracks()[0] };
    return c.micFx.track;
  }

  /** Что отправляется собеседнику: обработанный звук или сам микрофон. */
  _sendTrack(c) {
    return c.micFx?.track || c.local.mic || null;
  }

  /** Микрофон: выбранный (если он ещё подключён) или системный. */
  _audioConstraints() {
    const a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (this.micId) a.deviceId = { ideal: this.micId };
    return a;
  }

  async toggleCamera() {
    const c = this.call;
    if (!c || !(c.pc || (c.group && c.phase === 'active'))) return;
    if (c.local.cam) {
      c.local.cam.stop();
      c.local.cam = null;
      await this._replace(c, T_CAM, null);
    } else {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const track = s.getVideoTracks()[0];
      if (this.call !== c || c.phase === 'ended') return track?.stop();
      c.local.cam = track;
      await this._replace(c, T_CAM, c.local.cam);
    }
    this._sendState();
    this._emit();
  }

  async toggleScreen() {
    const c = this.call;
    if (!c || !(c.pc || (c.group && c.phase === 'active'))) return;
    if (c.local.screen) {
      this._stopScreen();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t('Трансляция экрана не поддерживается на этом устройстве'));
    // Не больше 1080p: экран 2K/4K при битрейте в пару мегабит и приоритете разрешения
    // превращается в слайд-шоу. Пропорции экрана сохраняются.
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: SCREEN_MAX_WIDTH }, height: { max: SCREEN_MAX_HEIGHT }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
    const track = s.getVideoTracks()[0];
    if (!this.call || this.call !== c) return track.stop();
    track.contentHint = 'detail'; // текст на экране важнее плавности
    track.addEventListener('ended', () => this.call === c && this._stopScreen());
    c.local.screen = track;
    await this._replace(c, T_SCREEN, track);
    for (const pc of this._pcs(c)) await this._tuneScreen(pc.getTransceivers()[T_SCREEN]?.sender);
    this._sendState();
    this._emit();
  }

  _stopScreen() {
    const c = this.call;
    if (!c?.local.screen) return;
    c.local.screen.stop();
    c.local.screen = null;
    this._replace(c, T_SCREEN, null).catch(() => {});
    this._sendState();
    this._emit();
  }

  // ---------- Кто говорит ----------

  /**
   * Кто сейчас говорит: { me, peer, peers: Set(адрес) }. Уровень собеседников — из RTP
   * (getSynchronizationSources, без WebAudio), свой — анализатором микрофона. Выключенный
   * микрофон не «говорит».
   */
  speaking() {
    const c = this.call;
    if (!c || c.phase === 'ended' || c.phase === 'incoming') return null;
    const out = { me: false, peer: false, peers: new Set() };
    const level = (pc) => {
      const src = pc?.getTransceivers()[T_AUDIO]?.receiver?.getSynchronizationSources?.()[0];
      if (!src) return 0;
      // Время последнего пакета: при тишине (DTX) пакеты не идут и уровень «застывает»
      const ts = src.timestamp;
      const fresh = Math.abs(ts - performance.now()) < 1000 || Math.abs(ts - (performance.timeOrigin + performance.now())) < 1000 || Math.abs(ts - Date.now()) < 1000;
      return fresh ? src.audioLevel || 0 : 0;
    };
    // Речь прерывистая: «говорит» держится SPEAK_HOLD после последнего громкого кусочка
    const now = Date.now();
    const held = (key, loud) => {
      c.spoke ||= new Map();
      if (loud) c.spoke.set(key, now);
      return now - (c.spoke.get(key) || 0) < SPEAK_HOLD;
    };
    if (c.group) {
      for (const [a, p] of c.peers) if (held(a, p.connected && p.remoteState.mic && level(p.pc) > SPEAK_LEVEL) && p.remoteState.mic) out.peers.add(a);
    } else if (c.pc) {
      out.peer = held('peer', c.remoteState.mic && level(c.pc) > SPEAK_LEVEL) && c.remoteState.mic;
    }
    const micOn = !!c.local.mic?.enabled;
    out.me = held('me', micOn && this._micLevel(c) > SPEAK_LEVEL) && micOn;
    return out;
  }

  _micLevel(c) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC || !c.local.mic) return 0;
    if (!c.meter || c.meter.track !== c.local.mic) {
      c.meter?.ctx.close().catch(() => {});
      try {
        const ctx = new AC();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(new MediaStream([c.local.mic])).connect(an);
        ctx.resume().catch(() => {});
        c.meter = { ctx, an, buf: new Float32Array(an.fftSize), track: c.local.mic };
      } catch {
        return 0;
      }
    }
    const { an, buf } = c.meter;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length) * 3; // RMS примерно в шкале audioLevel
  }

  // ---------- Внутреннее ----------

  /** Все соединения звонка: одно в звонке 1:1, по одному на участника в групповом. */
  _pcs(c) {
    if (c.group) return [...c.peers.values()].map((p) => p.pc).filter(Boolean);
    return c.pc ? [c.pc] : [];
  }

  /** Заменить отправляемую дорожку (звук, камера или экран) во всех соединениях звонка. */
  async _replace(c, idx, track) {
    await Promise.all(this._pcs(c).map((pc) => pc.getTransceivers()[idx]?.sender.replaceTrack(track).catch(() => {})));
  }

  async _tuneScreen(sender) {
    if (!sender) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = SCREEN_MAX_BITRATE;
      p.degradationPreference = 'maintain-resolution';
      await sender.setParameters(p);
    } catch {}
  }

  _newCall(o) {
    return {
      id: o.id || rid(),
      peer: o.peer,
      peerDevice: o.peerDevice || null,
      role: o.role,
      video: !!o.video,
      phase: o.phase,
      pc: null,
      dc: null,
      local: { mic: null, cam: null, screen: null },
      remote: { audio: new MediaStream(), cam: new MediaStream(), screen: new MediaStream() },
      remoteState: { mic: true, cam: false, screen: false },
      startedAt: null,
      createdAt: Date.now(),
      result: null,
      error: null,
    };
  }

  async _getLocalMedia(video) {
    const c = this.call;
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: this._audioConstraints(),
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (e) {
      if (video) {
        // Камеры нет или нет разрешения — звоним без видео
        s = await navigator.mediaDevices.getUserMedia({ audio: this._audioConstraints() });
      } else {
        throw new Error(e?.name === 'NotAllowedError' ? t('Нет доступа к микрофону') : t('Микрофон недоступен'));
      }
    }
    if (this.call !== c) {
      s.getTracks().forEach((tr) => tr.stop());
      throw new Error('cancelled');
    }
    c.local.mic = s.getAudioTracks()[0] || null;
    c.local.cam = s.getVideoTracks()[0] || null;
    if (this.micGain !== 1) this._buildMicFx(c);
  }

  async _createPeer() {
    const c = this.call;
    let iceServers = [];
    try {
      iceServers = await this.client.getIceServers();
    } catch {}
    const pc = (c.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' }));
    c.dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
    c.dc.onopen = () => this._sendState();
    c.dc.onmessage = (e) => this._onCtl(e.data);

    if (c.role === 'caller') {
      pc.addTransceiver(this._sendTrack(c) || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(c.local.cam || 'video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' }); // экран
    }

    pc.ontrack = (e) => {
      const idx = pc.getTransceivers().indexOf(e.transceiver);
      const target = idx === T_AUDIO ? c.remote.audio : idx === T_CAM ? c.remote.cam : idx === T_SCREEN ? c.remote.screen : null;
      if (!target) return;
      for (const tr of target.getTracks()) target.removeTrack(tr);
      target.addTrack(e.track);
      e.track.onmute = e.track.onunmute = () => this._emit();
      this._emit();
    };

    pc.onconnectionstatechange = () => {
      if (this.call !== c) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        clearTimeout(c.dropTimer);
        if (!c.startedAt) {
          c.startedAt = Date.now();
          c.phase = 'active';
        }
        c.reconnecting = false;
        this._emit();
      } else if (st === 'disconnected') {
        c.reconnecting = true;
        this._emit();
        clearTimeout(c.dropTimer);
        c.dropTimer = setTimeout(() => this.call === c && this._end(c.startedAt ? 'answered' : 'failed'), DISCONNECT_GRACE);
      } else if (st === 'failed') {
        this._end(c.startedAt ? 'answered' : 'failed');
      }
    };
  }

  _sendCtl(obj) {
    const dc = this.call?.dc;
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(JSON.stringify(obj));
      } catch {}
    }
  }

  _sendState() {
    const c = this.call;
    if (!c) return;
    const st = { type: 'state', mic: !!c.local.mic?.enabled, cam: !!c.local.cam, screen: !!c.local.screen };
    if (c.group) for (const p of c.peers.values()) this._sendTo(p.dc, st);
    else this._sendCtl(st);
  }

  _sendTo(dc, obj) {
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(JSON.stringify(obj));
      } catch {}
    }
  }

  _onCtl(raw) {
    const c = this.call;
    if (!c) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === 'state') {
      c.remoteState = { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen };
      this._emit();
    } else if (m.type === 'hangup') {
      this._end('answered');
    }
  }

  async _onSignal({ from, fromDevice, data }) {
    const kind = data.kind;
    const c = this.call;

    if (kind === 'offer') {
      if (typeof data.sdp !== 'string' || data.sdp.length > 60_000) return;
      if (this.busy) {
        if (c.id === data.callId) return;
        this.client
          .sendEphemeral(from, { t: 'call', kind: 'busy', callId: data.callId, ts: Date.now() }, { deviceIds: [fromDevice] })
          .catch(() => {});
        return;
      }
      const n = (this.call = this._newCall({ id: data.callId, peer: from, peerDevice: fromDevice, role: 'callee', video: !!data.video, phase: 'incoming' }));
      n.offerSdp = data.sdp;
      n.ringTimer = setTimeout(() => this.call === n && n.phase === 'incoming' && this._end('missed'), RING_TIMEOUT + 5000);
      this.tones.ring();
      this._emit();
      return;
    }

    // Остальные сигналы относятся только к текущему звонку
    if (!c || c.id !== data.callId || c.peer !== from) return;

    if (c.role === 'caller') {
      if (c.phase !== 'outgoing' && !(kind === 'hangup' && fromDevice === c.peerDevice)) return;
      if (kind === 'answer') {
        if (typeof data.sdp !== 'string') return;
        this.tones.stop();
        clearTimeout(c.ringTimer);
        c.peerDevice = fromDevice;
        c.phase = 'connecting';
        this._emit();
        const others = (c.ringingDevices || []).filter((d) => d !== fromDevice);
        if (others.length) this._signal('cancel', { reason: 'elsewhere' }, others).catch(() => {});
        try {
          await c.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        } catch (e) {
          this._end('failed', e);
        }
      } else if (kind === 'decline' || kind === 'busy') {
        const others = (c.ringingDevices || []).filter((d) => d !== fromDevice);
        if (kind === 'busy' && others.length) {
          // одно устройство занято — остальные продолжают звонить
          c.ringingDevices = others;
          return;
        }
        if (others.length) this._signal('cancel', { reason: kind === 'busy' ? 'busy' : 'declined' }, others).catch(() => {});
        this._end(kind === 'busy' ? 'busy' : 'declined');
      } else if (kind === 'hangup') {
        this._end('answered');
      }
      return;
    }

    // Мы — вызываемый
    if (fromDevice !== c.peerDevice) return;
    if (kind === 'cancel' && c.phase === 'incoming') {
      this._end(data.reason === 'elsewhere' ? 'elsewhere' : 'missed');
    } else if (kind === 'hangup' || kind === 'cancel') {
      this._end(c.startedAt ? 'answered' : 'cancelled');
    }
  }

  // ---------- Групповой звонок ----------

  _myAddr() {
    const a = this.client.account;
    return a ? addrOf(a.username, a.deviceId) : '';
  }

  /** Идущий звонок в группе (или в голосовом канале vc сообщества): { callId, video, from, parts: Map, mine } или null. */
  groupCallIn(chat, vc = null) {
    const c = this.call;
    if (c?.group && c.peer === chat && (c.vc || null) === (vc || null) && c.phase !== 'ended' && c.phase !== 'incoming') {
      const parts = new Map([[this._myAddr(), { name: this.client.account.username, device: this.client.account.deviceId }]]);
      for (const [a, p] of c.peers) parts.set(a, { name: p.name, device: p.device });
      return { callId: c.id, video: c.video, from: c.from || this.client.account.username, parts, mine: true };
    }
    const r = this.rosters.get(rosterKey(chat, vc));
    return r && r.parts.size ? r : null;
  }

  /** Голосовые каналы сообщества, в которых кто-то есть: Map(канал → участники { name, device }[]). */
  voiceIn(chat) {
    const out = new Map();
    for (const k of this.rosters.keys()) {
      const i = k.indexOf('/');
      if (i < 0 || k.slice(0, i) !== chat) continue;
      const vc = k.slice(i + 1);
      const r = this.groupCallIn(chat, vc);
      if (r) out.set(vc, [...r.parts.values()]);
    }
    const c = this.call;
    if (c?.vc && c.peer === chat && c.phase !== 'ended' && c.phase !== 'incoming') out.set(c.vc, [...this.groupCallIn(chat, c.vc).parts.values()]);
    return out;
  }

  /**
   * Зайти в голосовой канал сообщества: без звонка — если там кто-то есть, присоединиться,
   * иначе вы первый в комнате (остальные увидят вас в канале).
   */
  async joinVoice(chat, vc, { video = false } = {}) {
    if (!VC_RE.test(String(vc))) return;
    const c = this.call;
    if (c?.vc === vc && c.peer === chat && c.phase !== 'ended') return;
    if (this.busy) throw new Error(t('Уже идёт звонок'));
    const r = this.groupCallIn(chat, vc);
    if (r) return this.joinGroup(chat, { video, vc });
    const n = (this.call = this._newGroupCall({ peer: chat, vc, role: 'caller', video, phase: 'preparing' }));
    this._emit();
    try {
      await this._getLocalMedia(video);
      if (this.call !== n) return;
      n.phase = 'active';
      n.startedAt = Date.now();
      this._emit();
      this.onRoster(chat);
      await this.client.sendGroupCall(chat, { kind: 'join', callId: n.id, video, vc }, { others: 'all' });
      this._startAlive(n);
    } catch (e) {
      if (this.call === n) this._end('failed', e);
      throw e;
    }
  }

  _newGroupCall(o) {
    const c = this._newCall(o);
    c.group = o.peer.slice(1);
    c.peers = new Map(); // адрес → участник
    c.from = o.from || null;
    c.vc = o.vc || null; // голосовой канал сообщества (в него заходят без звонка)
    c.everJoined = false; // кто-то, кроме вас, был в звонке
    return c;
  }

  async _startGroup(chat, video) {
    // В группе уже идёт звонок — присоединиться к нему, а не начинать второй
    if (this.groupCallIn(chat)) return this.joinGroup(chat, { video });
    const c = (this.call = this._newGroupCall({ peer: chat, role: 'caller', video, phase: 'preparing' }));
    this._emit();
    try {
      await this._getLocalMedia(video);
      if (this.call !== c) return;
      c.phase = 'active';
      c.startedAt = Date.now();
      this._sendState();
      // Никто не присоединился — звонок заканчивается сам
      c.waitTimer = setTimeout(() => this.call === c && !c.everJoined && !c.peers.size && this._end('no_answer'), RING_TIMEOUT + 15_000);
      this._emit();
      this.onRoster(chat);
      await this.client.sendGroupCall(chat, { kind: 'ring', callId: c.id, video }, { others: 'all' });
      this._startAlive(c);
    } catch (e) {
      if (this.call === c) this._end('failed', e);
      throw e;
    }
  }

  /** Присоединиться к идущему звонку группы (или ответить на входящий). */
  async joinGroup(chat, { video = false, vc = null } = {}) {
    let c = this.call;
    if (!vc && c?.group && c.peer === chat && c.phase === 'incoming') {
      this.tones.stop();
      clearTimeout(c.ringTimer);
      c.video = video;
      c.phase = 'connecting';
    } else {
      if (this.busy) throw new Error(t('Уже идёт звонок'));
      const r = this.groupCallIn(chat, vc);
      if (!r) throw new Error(t('Звонок уже закончился'));
      if (r.parts.size >= GROUP_CALL_MAX) throw new Error(t('В звонке уже {0} участников — больше нельзя', GROUP_CALL_MAX));
      c = this.call = this._newGroupCall({ id: r.callId, peer: chat, vc, role: 'callee', video, phase: 'connecting', from: r.from });
    }
    this._emit();
    try {
      await this._getLocalMedia(video);
      if (this.call !== c) return;
      c.phase = 'active';
      c.startedAt = Date.now();
      // Ждём, что участники пришлют offer; никто не ответил — звонка уже нет
      // (в голосовом канале — просто остаёмся в нём одни)
      if (!c.vc) c.waitTimer = setTimeout(() => this.call === c && !c.peers.size && this._end(c.everJoined ? 'answered' : 'failed'), OFFER_TIMEOUT);
      this._emit();
      this.onRoster(chat);
      await this.client.sendGroupCall(chat, { kind: 'join', callId: c.id, video, ...(c.vc ? { vc: c.vc } : {}) }, { others: 'all' });
      this._startAlive(c);
    } catch (e) {
      if (this.call === c) this._end('failed', e);
      throw e;
    }
  }

  _leaveGroup() {
    const c = this.call;
    for (const p of c.peers.values()) this._sendTo(p.dc, { type: 'hangup' });
    const sent = this.client.sendGroupCall(c.peer, { kind: 'leave', callId: c.id, ...(c.vc ? { vc: c.vc } : {}) }, { others: 'all' }).catch(() => {});
    this._end(c.everJoined ? 'answered' : c.role === 'caller' ? 'no_answer' : 'cancelled');
    return sent;
  }

  /** Старший (по адресу) участник время от времени напоминает группе, что звонок идёт. */
  _startAlive(c) {
    clearInterval(c.aliveTimer);
    c.aliveTimer = setInterval(() => {
      if (this.call !== c || c.phase !== 'active') return clearInterval(c.aliveTimer);
      const parts = [this._myAddr(), ...c.peers.keys()].sort();
      if (parts[0] !== this._myAddr()) return;
      this.client.sendGroupCall(c.peer, { kind: 'alive', callId: c.id, video: c.video, parts, ...(c.vc ? { vc: c.vc } : {}) }, { others: 'online' }).catch(() => {});
    }, ALIVE_EVERY);
  }

  _expireRosters() {
    const now = Date.now();
    for (const [k, r] of this.rosters) {
      const mine = this.call?.group && this.call.id === r.callId && this.call.phase !== 'ended';
      if (!mine && now - r.seen > ROSTER_TTL) {
        this.rosters.delete(k);
        this.onRoster(k.split('/')[0]);
      }
    }
  }

  /** Сведения о звонке группы от участника: кто в нём сейчас. */
  _touchRoster(key, callId, from, fromDevice, data) {
    let r = this.rosters.get(key);
    if (!r || r.callId !== callId) {
      // Другой звонок в той же группе: новее (ring) или напоминание о существующем — заменяет
      r = { callId, video: !!data.video, from, parts: new Map(), seen: 0 };
      this.rosters.set(key, r);
    }
    if (data.kind === 'ring') r.from = from;
    if (data.kind === 'alive' && Array.isArray(data.parts)) {
      r.parts = new Map();
      for (const a of data.parts.slice(0, GROUP_CALL_MAX * 2)) {
        if (typeof a !== 'string' || !ADDR_RE.test(a)) continue;
        const i = a.lastIndexOf(':');
        r.parts.set(a, { name: a.slice(0, i), device: Number(a.slice(i + 1)) });
      }
    }
    r.parts.set(addrOf(from, fromDevice), { name: from, device: fromDevice });
    r.seen = Date.now();
  }

  async _onGroupSignal({ chat, from, fromDevice, data }) {
    const kind = data.kind;
    const callId = String(data.callId || '');
    if (!CALL_ID_RE.test(callId)) return;
    const me = this.client.account?.username;
    const fromAddr = addrOf(from, fromDevice);
    const vc = VC_RE.test(String(data.vc || '')) ? data.vc : null;
    const rk = rosterKey(chat, vc);
    const c = this.call;
    const inThis = !!c?.group && c.peer === chat && (c.vc || null) === vc && c.id === callId && c.phase !== 'ended';
    if (kind === 'ring' && vc) return; // в голосовой канал не звонят

    if (kind === 'ring' || kind === 'join' || kind === 'alive') {
      this._touchRoster(rk, callId, from, fromDevice, data);
      this.onRoster(chat);
      if (from === me) {
        // Ответили на этом же аккаунте с другого устройства — здесь перестаём звонить
        if (kind === 'join' && inThis && c.phase === 'incoming') this._end('elsewhere');
        return;
      }
      if (inThis && c.phase === 'active' && kind === 'join') return this._connectPeer(c, from, fromDevice);
      if (inThis && c.phase === 'active' && kind === 'alive') {
        // Кого-то из участников мы не видим (сигнал входа не дошёл) — соединиться;
        // offer шлёт тот, чей адрес меньше, чтобы не встречных два
        const mine = this._myAddr();
        for (const [a, p] of this.rosters.get(rk)?.parts || []) {
          if (a === mine || c.peers.has(a) || p.name === me || a > mine) continue;
          await this._connectPeer(c, p.name, p.device);
        }
        return;
      }
      if (kind === 'ring' && !this.busy) {
        const n = (this.call = this._newGroupCall({ id: callId, peer: chat, role: 'callee', video: !!data.video, phase: 'incoming', from }));
        n.ringTimer = setTimeout(() => this.call === n && n.phase === 'incoming' && this._end('missed'), RING_TIMEOUT);
        this.tones.ring();
        this._emit();
      }
      return;
    }

    if (kind === 'leave') {
      const r = this.rosters.get(rk);
      if (r?.callId === callId) {
        r.parts.delete(fromAddr);
        if (!r.parts.size) this.rosters.delete(rk);
        this.onRoster(chat);
      }
      if (!inThis) return;
      if (c.phase === 'incoming') {
        // Звонящий передумал, а больше в звонке никого — звонок пропущен
        if (!this.rosters.get(rk)?.parts.size) this._end('missed');
        return;
      }
      const p = c.peers.get(fromAddr);
      if (p) this._dropPeer(c, p);
      return;
    }

    if (!inThis || c.phase !== 'active' || from === me) return;
    if (typeof data.sdp !== 'string' || data.sdp.length > 60_000) return;
    if (kind === 'offer') return this._answerPeer(c, from, fromDevice, data.sdp);
    if (kind === 'answer') {
      const p = c.peers.get(fromAddr);
      if (!p || p.role !== 'offerer' || p.answered) return;
      p.answered = true;
      clearTimeout(p.offerTimer);
      try {
        await p.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      } catch {
        this._dropPeer(c, p);
      }
    }
  }

  _newPeer(c, name, device, role) {
    const p = {
      addr: addrOf(name, device),
      name,
      device,
      role,
      pc: null,
      dc: null,
      answered: false,
      connected: false,
      reconnecting: false,
      remote: { audio: new MediaStream(), cam: new MediaStream(), screen: new MediaStream() },
      remoteState: { mic: true, cam: false, screen: false },
    };
    c.peers.set(p.addr, p);
    return p;
  }

  async _groupPc(c, p) {
    let iceServers = [];
    try {
      iceServers = await this.client.getIceServers();
    } catch {}
    const pc = (p.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' }));
    p.dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
    p.dc.onopen = () => this._sendTo(p.dc, { type: 'state', mic: !!c.local.mic?.enabled, cam: !!c.local.cam, screen: !!c.local.screen });
    p.dc.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (c.peers.get(p.addr) !== p) return;
      if (m.type === 'state') {
        p.remoteState = { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen };
        this._emit();
      } else if (m.type === 'hangup') {
        this._dropPeer(c, p);
      }
    };
    if (p.role === 'offerer') {
      pc.addTransceiver(this._sendTrack(c) || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(c.local.cam || 'video', { direction: 'sendrecv' });
      pc.addTransceiver(c.local.screen || 'video', { direction: 'sendrecv' });
    }
    pc.ontrack = (e) => {
      const idx = pc.getTransceivers().indexOf(e.transceiver);
      const target = idx === T_AUDIO ? p.remote.audio : idx === T_CAM ? p.remote.cam : idx === T_SCREEN ? p.remote.screen : null;
      if (!target) return;
      for (const tr of target.getTracks()) target.removeTrack(tr);
      target.addTrack(e.track);
      e.track.onmute = e.track.onunmute = () => this._emit();
      this._emit();
    };
    pc.onconnectionstatechange = () => {
      if (c.peers.get(p.addr) !== p || this.call !== c) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        clearTimeout(p.dropTimer);
        clearTimeout(c.waitTimer);
        clearTimeout(c.aloneTimer);
        p.connected = true;
        p.reconnecting = false;
        c.everJoined = true;
        this._emit();
      } else if (st === 'disconnected') {
        p.reconnecting = true;
        this._emit();
        clearTimeout(p.dropTimer);
        p.dropTimer = setTimeout(() => this._dropPeer(c, p), DISCONNECT_GRACE);
      } else if (st === 'failed') {
        this._dropPeer(c, p);
      }
    };
  }

  /** Новый участник: мы уже в звонке — шлём ему offer. */
  async _connectPeer(c, name, device) {
    const a = addrOf(name, device);
    if (c.peers.has(a) || c.peers.size >= GROUP_CALL_MAX - 1) return;
    const p = this._newPeer(c, name, device, 'offerer');
    this._emit();
    try {
      await this._groupPc(c, p);
      if (c.peers.get(a) !== p) return;
      if (c.local.screen) await this._tuneScreen(p.pc.getTransceivers()[T_SCREEN]?.sender);
      await p.pc.setLocalDescription(await p.pc.createOffer());
      await waitIceGathering(p.pc);
      if (c.peers.get(a) !== p || this.call !== c) return;
      await this.client.sendGroupCall(c.peer, { kind: 'offer', callId: c.id, sdp: p.pc.localDescription.sdp, ...(c.vc ? { vc: c.vc } : {}) }, { devices: { [name]: [device] } });
      p.offerTimer = setTimeout(() => !p.answered && this._dropPeer(c, p), OFFER_TIMEOUT);
    } catch (e) {
      console.error('gcall offer', e);
      this._dropPeer(c, p);
    }
  }

  /** Offer от участника: отвечаем. Встречные offer — побеждает тот, чей адрес меньше. */
  async _answerPeer(c, name, device, sdp) {
    const a = addrOf(name, device);
    const old = c.peers.get(a);
    if (old) {
      if (old.role === 'offerer' && !old.answered && this._myAddr() < a) return; // наш offer главнее — ждём ответа на него
      this._closePeer(old); // встречный offer или участник переподключился
      c.peers.delete(a);
    }
    if (c.peers.size >= GROUP_CALL_MAX - 1) return;
    const p = this._newPeer(c, name, device, 'answerer');
    p.answered = true;
    this._emit();
    try {
      await this._groupPc(c, p);
      await p.pc.setRemoteDescription({ type: 'offer', sdp });
      const trs = p.pc.getTransceivers();
      for (const tr of trs) tr.direction = 'sendrecv';
      await trs[T_AUDIO]?.sender.replaceTrack(this._sendTrack(c));
      await trs[T_CAM]?.sender.replaceTrack(c.local.cam || null);
      await trs[T_SCREEN]?.sender.replaceTrack(c.local.screen || null);
      if (c.local.screen) await this._tuneScreen(trs[T_SCREEN]?.sender);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await waitIceGathering(p.pc);
      if (c.peers.get(a) !== p || this.call !== c) return;
      await this.client.sendGroupCall(c.peer, { kind: 'answer', callId: c.id, sdp: p.pc.localDescription.sdp, ...(c.vc ? { vc: c.vc } : {}) }, { devices: { [name]: [device] } });
    } catch (e) {
      console.error('gcall answer', e);
      this._dropPeer(c, p);
    }
  }

  _closePeer(p) {
    clearTimeout(p.dropTimer);
    clearTimeout(p.offerTimer);
    try {
      p.dc?.close();
    } catch {}
    try {
      p.pc?.close();
    } catch {}
  }

  _dropPeer(c, p) {
    if (c.peers.get(p.addr) !== p) return;
    this._closePeer(p);
    c.peers.delete(p.addr);
    this._emit();
    if (this.call !== c || c.phase === 'ended' || c.peers.size) return;
    if (c.vc) return; // голосовой канал: можно сидеть и одному
    // Остались одни: подождать — вдруг кто-то вернётся или присоединится
    clearTimeout(c.aloneTimer);
    c.aloneTimer = setTimeout(() => this.call === c && !c.peers.size && this._leaveGroup(), ALONE_TIMEOUT);
  }

  _end(result, error = null) {
    const c = this.call;
    if (!c || c.phase === 'ended') return;
    clearTimeout(c.ringTimer);
    clearTimeout(c.dropTimer);
    this.tones.stop();
    if (result !== 'elsewhere' && result !== 'missed') this.tones.end();
    if (c.group) {
      clearTimeout(c.waitTimer);
      clearTimeout(c.aloneTimer);
      clearInterval(c.aliveTimer);
      for (const p of [...c.peers.values()]) this._closePeer(p);
      c.peers.clear();
      const rk = rosterKey(c.peer, c.vc);
      const r = this.rosters.get(rk);
      if (r?.callId === c.id) {
        r.parts.delete(this._myAddr());
        if (!r.parts.size) this.rosters.delete(rk);
      }
      this.onRoster(c.peer);
    }
    for (const tr of Object.values(c.local)) tr?.stop();
    c.meter?.ctx.close().catch(() => {});
    c.meter = null;
    if (c.micFx) {
      c.micFx.track.stop();
      c.micFx.ctx.close().catch(() => {});
      c.micFx = null;
    }
    try {
      c.dc?.close();
    } catch {}
    try {
      c.pc?.close();
    } catch {}
    c.phase = 'ended';
    c.result = result;
    c.error = error ? String(error.message || error) : null;
    c.duration = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
    this._emit();
    // Голосовой канал сообщества — комната, а не звонок: в историю не пишется
    if (!c.vc) {
      this.client
        .logCall(c.peer, {
          callId: c.id, // одна запись о звонке на всех своих устройствах
          direction: c.role === 'caller' ? 'out' : 'in',
          result,
          duration: c.duration,
          video: c.video,
          missed: result === 'missed',
          group: !!c.group,
        })
        .catch(() => {});
    }
    setTimeout(() => {
      if (this.call === c) {
        this.call = null;
        this._emit();
      }
    }, 1500);
  }
}
