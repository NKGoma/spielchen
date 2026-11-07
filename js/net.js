// PeerJS wrapper. The TV (host) owns all state; the phone is a thin remote.
// Uses the global `Peer` from the PeerJS CDN script (1.5.x).

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I or O (and no digits, so no 0 or 1)
export const PEER_PREFIX = 'spielchen-';

export function makeRoomCode(rng = Math.random) {
  return Array.from({ length: 4 }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join('');
}

export function normaliseCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '').replace(/[IO]/g, '').slice(0, 4);
}

/** Optional PeerServer override for local testing: ?peer=localhost:9000 */
export function peerOptions() {
  try {
    const p = new URLSearchParams(location.search).get('peer');
    if (!p) return { debug: 0 };
    const [host, port] = p.split(':');
    return { host, port: Number(port) || 9000, path: '/', secure: false, debug: 0 };
  } catch { return { debug: 0 }; }
}

const hasPeer = () => typeof window !== 'undefined' && typeof window.Peer === 'function';

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------
export class HostNet {
  /** onAction(msg) for controller messages; onStatus(status) with 'offline' | 'starting' | 'waiting' | 'connected' | 'reconnecting'. */
  constructor({ onAction, onStatus, onController }) {
    this.onAction = onAction;
    this.onStatus = onStatus;
    this.onController = onController || (() => {});
    this.conns = [];
    this.controller = null;
    this.code = null;
    this.status = 'offline';
    this.lastSeen = 0;
    this.peer = null;
    this.retries = 0;
    this.opened = false;        // true once this room code has been registered with the server
    this.everOpened = false;
  }

  setStatus(s) { if (s !== this.status) { this.status = s; this.onStatus(s); } }

  /** resume: this code was ours before (e.g. the TV page was refreshed), so retry it instead of picking a new one. */
  start(code = makeRoomCode(), { resume = false } = {}) {
    if (resume) this.opened = true;
    if (!hasPeer()) { this.setStatus('offline'); return false; }
    this.code = code;
    this.setStatus('starting');
    const peer = new window.Peer(PEER_PREFIX + code, peerOptions());
    this.peer = peer;
    peer.on('open', () => { this.retries = 0; this.opened = true; this.everOpened = true; this.setStatus(this.controller ? 'connected' : 'waiting'); });
    peer.on('connection', conn => this._accept(conn));
    peer.on('disconnected', () => { if (!peer.destroyed) { this.setStatus('reconnecting'); setTimeout(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 1000); } });
    peer.on('error', err => {
      if (err && err.type === 'unavailable-id') {
        peer.destroy();
        // First open: the code is taken by someone else, pick a new one.
        // Later (we reconnected while the server still held our old session): keep the same code, so phones can find us.
        if (!this.opened) { this.start(makeRoomCode()); return; }
        this._restartSameCode();
        return;
      }
      if (err && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed' || err.type === 'disconnected')) {
        this.setStatus('reconnecting');
        if (peer.destroyed) this._restartSameCode();
      }
    });
    clearInterval(this._watch);
    this._watch = setInterval(() => this._watchdog(), 2000);
    return true;
  }

  _restartSameCode() {
    this.setStatus('reconnecting');
    if (!this.everOpened && this.retries >= 5) { this.opened = false; this.retries = 0; this.start(makeRoomCode()); return; }
    const delay = Math.min(16000, 2000 * Math.pow(2, Math.min(this.retries, 3)));
    this.retries++;
    if (this.retries > 40) return;   // give up after a few minutes; hot-seat still works
    clearTimeout(this._restart);
    this._restart = setTimeout(() => this.start(this.code), delay);
  }

  _accept(conn) {
    conn.on('open', () => {
      this.conns = this.conns.filter(c => c.open && c !== conn);
      this.conns.push(conn);
      this.controller = conn;              // newest connection is the controller
      this.lastSeen = Date.now();
      this.setStatus('connected');
      this.onController(true);
    });
    conn.on('data', raw => {
      let msg = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { return; } }
      if (!msg || typeof msg !== 'object') return;
      if (conn === this.controller) this.lastSeen = Date.now();
      if (msg.t === 'ping' || msg.t === 'hello') { this.onController(true, conn === this.controller); return; }
      if (msg.t === 'claim') { this.controller = conn; this.lastSeen = Date.now(); this.setStatus('connected'); this.onController(true); return; }
      if (conn === this.controller) this.onAction(msg);
    });
    const drop = () => {
      this.conns = this.conns.filter(c => c !== conn);
      if (conn === this.controller) {
        this.controller = this.conns[this.conns.length - 1] || null;
        this.setStatus(this.controller ? 'connected' : 'reconnecting');
        this.onController(!!this.controller);
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  _watchdog() {
    // A server reconnect that hangs silently: start over on the same code.
    const p = this.peer;
    if (p && p.disconnected && !p.destroyed) {
      this._discAt = this._discAt || Date.now();
      if (Date.now() - this._discAt > 10000) { this._discAt = 0; try { p.destroy(); } catch { /* ignore */ } this._restartSameCode(); }
    } else this._discAt = 0;
    if (!this.controller) return;
    const quiet = Date.now() - this.lastSeen;
    if (quiet > 7000 && this.status === 'connected') this.setStatus('reconnecting');
    else if (quiet <= 7000 && this.status === 'reconnecting' && this.peer && !this.peer.disconnected) this.setStatus('connected');
  }

  /** Send a view to every phone: build(role) returns the message for 'controller' or 'spectator'. */
  broadcast(build) {
    for (const c of this.conns) {
      if (!c.open) continue;
      try { c.send(JSON.stringify(build(c === this.controller ? 'controller' : 'spectator'))); } catch { /* ignore */ }
    }
  }

  get connected() { return !!this.controller && this.status === 'connected'; }
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------
export class PhoneNet {
  constructor({ code, onMessage, onStatus }) {
    this.code = code;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.status = 'connecting';
    this.conn = null;
    this.peer = null;
    this.lastMsg = 0;
    this.timer = null;
  }

  setStatus(s) { if (s !== this.status) { this.status = s; this.onStatus(s); } }

  connect() {
    if (!hasPeer()) { this.setStatus('offline'); return; }
    this.setStatus(this.conn ? 'reconnecting' : 'connecting');
    if (!this.peer || this.peer.destroyed) {
      this.peer = new window.Peer(undefined, peerOptions());
      this.peer.on('open', () => this._dial());
      this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch { /* ignore */ } });
      this.peer.on('error', () => this._retry());
    } else if (this.peer.open) {
      this._dial();
    } else if (this.peer.disconnected) {
      try { this.peer.reconnect(); } catch { this._retry(); }
    }
    clearInterval(this._watch);
    this._watch = setInterval(() => this._watchdog(), 2000);
  }

  _dial() {
    if (this.conn) { try { this.conn.close(); } catch { /* ignore */ } }
    const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true });
    this.conn = conn;
    const openTimer = setTimeout(() => { if (!conn.open) this._retry(); }, 6000);
    conn.on('open', () => {
      clearTimeout(openTimer);
      this.lastMsg = Date.now();
      this.setStatus('connected');
      this.send({ t: 'hello' });
    });
    conn.on('data', raw => {
      this.lastMsg = Date.now();
      if (this.status !== 'connected') this.setStatus('connected');
      let msg = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { return; } }
      this.onMessage(msg);
    });
    conn.on('close', () => { if (this.conn === conn) this._retry(); });
    conn.on('error', () => { if (this.conn === conn) this._retry(); });
  }

  _retry() {
    this.setStatus('reconnecting');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.peer && this.peer.destroyed) this.peer = null;
      this.connect();
    }, 2000);
  }

  _watchdog() {
    if (this.status === 'connected') {
      this.send({ t: 'ping' });
      if (Date.now() - this.lastMsg > 8000) this._retry();
    }
  }

  send(msg) {
    if (this.conn && this.conn.open) { try { this.conn.send(JSON.stringify(msg)); return true; } catch { /* ignore */ } }
    return false;
  }
}
