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

const RING_TIMEOUT = 45_000;
const ICE_GATHER_TIMEOUT = 4_000;
const DISCONNECT_GRACE = 10_000;
const SCREEN_MAX_BITRATE = 3_000_000;
const SCREEN_MAX_WIDTH = 1920;
const SCREEN_MAX_HEIGHT = 1080;

const T_AUDIO = 0;
const T_CAM = 1;
const T_SCREEN = 2;

const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

function waitIceGathering(pc, ms = ICE_GATHER_TIMEOUT) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCand);
      resolve();
    };
    const onState = () => pc.iceGatheringState === 'complete' && done();
    const onCand = (e) => !e.candidate && done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCand);
  });
}

// ---------- Звуки звонка (генерируются WebAudio, без файлов) ----------
class Tones {
  constructor() {
    this.ctx = null;
    this.timer = null;
  }
  _ctx() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
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
  answered: 'звонок',
  missed: 'пропущенный звонок',
  declined: 'отклонён',
  busy: 'занято',
  no_answer: 'нет ответа',
  unavailable: 'собеседник не в сети',
  failed: 'не удалось соединиться',
  cancelled: 'отменён',
  elsewhere: 'отвечен на другом устройстве',
};

export class CallManager {
  /**
   * @param {object} o
   * @param {import('../shared/client-core.js').MessengerClient} o.client
   * @param {Function} [o.onChange]  вызывается при любом изменении состояния
   */
  constructor({ client, onChange = () => {} }) {
    this.client = client;
    this.onChange = onChange;
    this.call = null;
    this.tones = new Tones();
    client.on('call-signal', (s) => this._onSignal(s).catch((e) => console.error('call', e)));
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
    if (this.busy) throw new Error('Уже идёт звонок');
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
      await trs[T_AUDIO]?.sender.replaceTrack(c.local.mic || null);
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
    this._signal('decline', {}, [c.peerDevice]).catch(() => {});
    this._end('declined');
  }

  // ---------- Во время звонка ----------

  hangup() {
    const c = this.call;
    if (!c || c.phase === 'ended') return;
    if (c.phase === 'incoming') return this.decline();
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

  async toggleCamera() {
    const c = this.call;
    if (!c?.pc) return;
    const sender = c.pc.getTransceivers()[T_CAM]?.sender;
    if (c.local.cam) {
      c.local.cam.stop();
      c.local.cam = null;
      await sender?.replaceTrack(null);
    } else {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      c.local.cam = s.getVideoTracks()[0];
      await sender?.replaceTrack(c.local.cam);
    }
    this._sendState();
    this._emit();
  }

  async toggleScreen() {
    const c = this.call;
    if (!c?.pc) return;
    const sender = c.pc.getTransceivers()[T_SCREEN]?.sender;
    if (c.local.screen) {
      this._stopScreen();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Трансляция экрана не поддерживается на этом устройстве');
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
    await sender?.replaceTrack(track);
    try {
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = SCREEN_MAX_BITRATE;
      p.degradationPreference = 'maintain-resolution';
      await sender.setParameters(p);
    } catch {}
    this._sendState();
    this._emit();
  }

  _stopScreen() {
    const c = this.call;
    if (!c?.local.screen) return;
    c.local.screen.stop();
    c.local.screen = null;
    c.pc?.getTransceivers()[T_SCREEN]?.sender.replaceTrack(null).catch(() => {});
    this._sendState();
    this._emit();
  }

  // ---------- Внутреннее ----------

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
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (e) {
      if (video) {
        // Камеры нет или нет разрешения — звоним без видео
        s = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        throw new Error(e?.name === 'NotAllowedError' ? 'Нет доступа к микрофону' : 'Микрофон недоступен');
      }
    }
    if (this.call !== c) {
      s.getTracks().forEach((t) => t.stop());
      throw new Error('cancelled');
    }
    c.local.mic = s.getAudioTracks()[0] || null;
    c.local.cam = s.getVideoTracks()[0] || null;
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
      pc.addTransceiver(c.local.mic || 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(c.local.cam || 'video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' }); // экран
    }

    pc.ontrack = (e) => {
      const idx = pc.getTransceivers().indexOf(e.transceiver);
      const target = idx === T_AUDIO ? c.remote.audio : idx === T_CAM ? c.remote.cam : idx === T_SCREEN ? c.remote.screen : null;
      if (!target) return;
      for (const t of target.getTracks()) target.removeTrack(t);
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
    this._sendCtl({ type: 'state', mic: !!c.local.mic?.enabled, cam: !!c.local.cam, screen: !!c.local.screen });
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

  _end(result, error = null) {
    const c = this.call;
    if (!c || c.phase === 'ended') return;
    clearTimeout(c.ringTimer);
    clearTimeout(c.dropTimer);
    this.tones.stop();
    if (result !== 'elsewhere' && result !== 'missed') this.tones.end();
    for (const t of Object.values(c.local)) t?.stop();
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
    this.client
      .logCall(c.peer, {
        direction: c.role === 'caller' ? 'out' : 'in',
        result,
        duration: c.duration,
        video: c.video,
        missed: result === 'missed',
      })
      .catch(() => {});
    setTimeout(() => {
      if (this.call === c) {
        this.call = null;
        this._emit();
      }
    }, 1500);
  }
}
