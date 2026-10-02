// Минимальный WebSocket-сервер (RFC 6455) без внешних зависимостей.
// Поддерживает текстовые кадры, фрагментацию, ping/pong и close.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptUpgrade(req, socket, onConnection, { maxPayload = 1 << 20 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  onConnection(new WSConnection(socket, maxPayload));
}

export class WSConnection extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.max = maxPayload;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.open = true;
    this.alive = true;
    socket.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      try {
        this._parse();
      } catch {
        this.close(1002, 'protocol error');
      }
    });
    socket.on('close', () => {
      this.open = false;
      this.emit('close');
    });
    socket.on('error', () => socket.destroy());
  }

  _parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if (b0 & 0x70) throw new Error('RSV bits set');
      if ((b1 & 0x80) === 0) throw new Error('client frames must be masked');
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.max)) throw new Error('frame too large');
        len = Number(big);
        off = 10;
      }
      if (len > this.max) throw new Error('frame too large');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, p) {
    switch (op) {
      case 0x8: // close
        this.close();
        return;
      case 0x9: // ping
        this._send(0xa, p);
        return;
      case 0xa: // pong
        this.alive = true;
        return;
      case 0x1:
      case 0x2:
        if (this.frag) throw new Error('unexpected new message during fragmentation');
        if (fin) {
          if (op === 0x1) this.emit('message', p.toString('utf8'));
        } else {
          this.frag = { op, parts: [p], size: p.length };
        }
        return;
      case 0x0: {
        if (!this.frag) throw new Error('unexpected continuation');
        this.frag.parts.push(p);
        this.frag.size += p.length;
        if (this.frag.size > this.max) throw new Error('message too large');
        if (fin) {
          const { op: fop, parts } = this.frag;
          this.frag = null;
          if (fop === 0x1) this.emit('message', Buffer.concat(parts).toString('utf8'));
        }
        return;
      }
      default:
        throw new Error('unknown opcode');
    }
  }

  _send(op, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let h;
    if (len < 126) {
      h = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      h = Buffer.alloc(4);
      h[0] = 0x80 | op;
      h[1] = 126;
      h.writeUInt16BE(len, 2);
    } else {
      h = Buffer.alloc(10);
      h[0] = 0x80 | op;
      h[1] = 127;
      h.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([h, payload]));
  }

  send(text) {
    this._send(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const b = Buffer.alloc(2 + Buffer.byteLength(reason));
    b.writeUInt16BE(code, 0);
    b.write(reason, 2);
    this._send(0x8, b);
    this.open = false;
    this.socket.end();
  }
}
