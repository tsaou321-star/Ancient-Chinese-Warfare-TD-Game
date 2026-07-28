'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const APP_VERSION = '0.10.18';
const PROTOCOL_VERSION = 4;
const GAME_FILE = path.join(ROOT, 'index.html');
const TICK_RATE = 30;
const START_DELAY_MS = 3000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VALID_COMMANDS = new Set(['recruit', 'drop', 'dropToBench', 'activeSkill', 'surrender']);
const HEARTBEAT_INTERVAL_MS = 25000;
const PEER_TIMEOUT_MS = 70000;

function contentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg'
  }[ext] || 'application/octet-stream';
}

function sendHttp(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    sendHttp(res, 405, 'Method Not Allowed');
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    sendHttp(res, 200, JSON.stringify({ ok: true, version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, rooms: rooms.size, tickRate: TICK_RATE }), 'application/json; charset=utf-8');
    return;
  }

  let filename;
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/game.html') {
    filename = GAME_FILE;
  } else {
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resolved = path.resolve(ROOT, relative);
    if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) {
      sendHttp(res, 403, 'Forbidden');
      return;
    }
    filename = resolved;
  }

  fs.readFile(filename, (error, data) => {
    if (error) {
      sendHttp(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not Found' : 'Server Error');
      return;
    }
    sendHttp(res, 200, data, contentType(filename));
  });
});

function websocketAccept(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (data.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = data.length;
  } else if (data.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

class WebSocketPeer {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.room = null;
    this.sideId = null;
    this.player = null;
    this.ready = false;
    this.rateWindowStarted = Date.now();
    this.rateCount = 0;
    this.lastPongAt = Date.now();

    socket.on('data', chunk => this.onData(chunk));
    socket.on('close', () => this.close(false));
    socket.on('end', () => this.close(false));
    socket.on('error', () => this.close(false));
  }

  send(message) {
    if (this.closed || this.socket.destroyed) return;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    this.socket.write(encodeFrame(text, 0x1));
  }

  sendPong(payload) {
    if (!this.closed && !this.socket.destroyed) this.socket.write(encodeFrame(payload, 0xA));
  }

  sendPing() {
    if (!this.closed && !this.socket.destroyed) this.socket.write(encodeFrame(Buffer.from(String(Date.now())), 0x9));
  }

  close(sendFrame = true) {
    if (this.closed) return;
    this.closed = true;
    if (sendFrame && !this.socket.destroyed) {
      try { this.socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
    }
    try { this.socket.destroy(); } catch {}
    detachPeer(this);
  }

  allowCommand() {
    const now = Date.now();
    if (now - this.rateWindowStarted >= 1000) {
      this.rateWindowStarted = now;
      this.rateCount = 0;
    this.lastPongAt = Date.now();
    }
    this.rateCount += 1;
    return this.rateCount <= 40;
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (!fin) {
        this.send({ type: 'error', message: '不支援分段 WebSocket 訊息' });
        this.close();
        return;
      }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const value = this.buffer.readBigUInt64BE(2);
        if (value > BigInt(MAX_MESSAGE_BYTES)) {
          this.close();
          return;
        }
        length = Number(value);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.close();
        return;
      }
      if (!masked) {
        this.close();
        return;
      }
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendPong(payload);
        continue;
      }
      if (opcode === 0xA) {
        this.lastPongAt = Date.now();
        continue;
      }
      if (opcode !== 0x1) continue;

      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch {
        this.send({ type: 'error', message: '訊息格式錯誤' });
        continue;
      }
      this.lastPongAt = Date.now();
      handleMessage(this, message);
    }
  }
}

const peers = new Set();

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    '\r\n'
  ].join('\r\n'));
  const peer = new WebSocketPeer(socket);
  peers.add(peer);
});

class MatchRoom {
  constructor(code) {
    this.code = code;
    this.peers = { player: null, rival: null };
    this.players = { player: null, rival: null };
    this.ready = { player: false, rival: false };
    this.status = 'waiting';
    this.tick = 0;
    this.sequence = 0;
    this.timer = null;
    this.startTimer = null;
    this.createdAt = Date.now();
    this.commandLog = [];
  }

  broadcast(message) {
    this.peers.player?.send(message);
    this.peers.rival?.send(message);
  }

  broadcastState() {
    this.broadcast({
      type: 'room_state',
      roomCode: this.code,
      players: this.players,
      ready: this.ready,
      status: this.status
    });
  }

  attach(peer, sideId, player) {
    this.peers[sideId] = peer;
    this.players[sideId] = sanitizePlayer(player);
    peer.room = this;
    peer.sideId = sideId;
    peer.player = this.players[sideId];
  }

  maybeStart() {
    if (this.status !== 'waiting') return;
    if (!this.peers.player || !this.peers.rival || !this.ready.player || !this.ready.rival) return;
    this.status = 'starting';
    const seed = crypto.randomBytes(4).readUInt32BE(0);
    this.seed = seed;
    const startsAt = Date.now() + START_DELAY_MS;
    this.broadcastState();
    this.broadcast({
      type: 'match_start',
      roomCode: this.code,
      seed,
      tickRate: TICK_RATE,
      startDelayMs: START_DELAY_MS,
      startsAt,
      players: this.players
    });
    this.startTimer = setTimeout(() => this.startClock(), START_DELAY_MS);
  }

  startClock() {
    if (this.status !== 'starting') return;
    this.status = 'running';
    this.tick = 0;
    const interval = 1000 / TICK_RATE;
    this.timer = setInterval(() => {
      if (this.status !== 'running') return;
      this.tick += 1;
      this.broadcast({ type: 'tick', tick: this.tick });
    }, interval);
  }

  acceptCommand(peer, rawCommand) {
    if (this.status !== 'running' && this.status !== 'starting') {
      peer.send({ type: 'error', message: '戰局尚未開始' });
      return;
    }
    if (!peer.allowCommand()) {
      peer.send({ type: 'error', message: '操作太頻繁' });
      return;
    }
    const command = sanitizeCommand(rawCommand, peer.sideId);
    if (!command) {
      peer.send({ type: 'error', message: '不合法的操作命令' });
      return;
    }
    const applyTick = Math.max(1, this.tick + 3);
    const message = { type: 'command', applyTick, sequence: ++this.sequence, command };
    this.commandLog.push(message);
    if (this.commandLog.length > 5000) this.commandLog.splice(0, this.commandLog.length - 5000);
    this.broadcast(message);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.timer = null;
    this.startTimer = null;
    this.status = 'closed';
  }
}

const rooms = new Map();

function makeRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate room code');
}

function sanitizePlayer(player) {
  const name = String(player?.name || '玩家').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) || '玩家';
  const rank = String(player?.rank || '士卒').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12) || '士卒';
  const rawHatId = typeof player?.hatId === 'string' ? player.hatId.trim() : '';
  const hatId = /^[a-z0-9_-]{1,40}$/i.test(rawHatId) ? rawHatId : null;
  const loadout = Array.isArray(player?.loadout)
    ? player.loadout.map(value => String(value).slice(0, 40)).filter(Boolean).slice(0, 4)
    : [];
  return { name, rank, hatId, loadout };
}

function integer(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function sanitizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'bench') {
    const index = integer(source.index, 0, 4);
    return index === null ? null : { type: 'bench', index };
  }
  if (source.type === 'board') {
    const unitId = integer(source.unitId, 1, 10_000_000);
    return unitId === null ? null : { type: 'board', unitId };
  }
  return null;
}

function sanitizeCommand(command, assignedSideId) {
  if (!command || typeof command !== 'object' || !VALID_COMMANDS.has(command.type)) return null;
  if (command.type === 'recruit' || command.type === 'surrender') return { type: command.type, sideId: assignedSideId };
  if (command.type === 'drop') {
    const source = sanitizeSource(command.source);
    const col = integer(command.col, 0, 7);
    const row = integer(command.row, 0, 9);
    return source && col !== null && row !== null ? { type: 'drop', sideId: assignedSideId, source, col, row } : null;
  }
  if (command.type === 'dropToBench') {
    const source = sanitizeSource(command.source);
    const index = integer(command.index, 0, 4);
    return source && index !== null ? { type: 'dropToBench', sideId: assignedSideId, source, index } : null;
  }
  if (command.type === 'activeSkill') {
    const col = integer(command.col, 0, 7);
    const row = integer(command.row, 0, 9);
    const slotIndex = integer(command.slotIndex, 0, 1);
    const skillId = String(command.skillId || '').slice(0, 40);
    return col !== null && row !== null && slotIndex !== null && skillId
      ? { type: 'activeSkill', sideId: assignedSideId, skillId, slotIndex, col, row }
      : null;
  }
  return null;
}

function normalizeRoomCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}


function validRoomCode(value) {
  return /^[A-Z0-9]{1,8}$/.test(value);
}

function handleMessage(peer, message) {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'create_room') {
    if (peer.room) return peer.send({ type: 'error', message: '你已經在房間中' });
    const code = normalizeRoomCode(message.roomCode);
    if (!validRoomCode(code)) return peer.send({ type: 'error', message: '請輸入 1～8 位英文字母或數字' });
    if (rooms.has(code)) return peer.send({ type: 'error', message: '這個房間代號已被使用' });
    const room = new MatchRoom(code);
    rooms.set(code, room);
    room.attach(peer, 'player', message.player);
    console.log(`[房間 ${code}] 已建立`);
    peer.send({ type: 'room_created', roomCode: code, sideId: 'player' });
    room.broadcastState();
    return;
  }

  if (message.type === 'join_room') {
    if (peer.room) return peer.send({ type: 'error', message: '你已經在房間中' });
    const code = normalizeRoomCode(message.roomCode);
    if (!validRoomCode(code)) return peer.send({ type: 'error', message: '請輸入 1～8 位英文字母或數字' });
    const room = rooms.get(code);
    if (!room) return peer.send({ type: 'error', message: '找不到這個房間' });
    if (room.status !== 'waiting' || room.peers.rival) return peer.send({ type: 'error', message: '房間已滿或戰局已開始' });
    room.attach(peer, 'rival', message.player);
    console.log(`[房間 ${code}] 對手已加入`);
    peer.send({ type: 'room_joined', roomCode: code, sideId: 'rival' });
    room.peers.player?.send({ type: 'peer_joined', roomCode: code });
    room.broadcastState();
    return;
  }

  if (message.type === 'ready' || message.type === 'set_ready') {
    if (!peer.room || !peer.sideId) return peer.send({ type: 'error', message: '尚未加入房間' });
    if (peer.room.status !== 'waiting') return peer.send({ type: 'error', message: '戰局已經開始倒數' });
    peer.player = sanitizePlayer(message.player || peer.player);
    peer.room.players[peer.sideId] = peer.player;
    const isReady = message.type === 'ready' ? true : Boolean(message.ready);
    peer.ready = isReady;
    peer.room.ready[peer.sideId] = isReady;
    peer.room.broadcastState();
    peer.room.maybeStart();
    return;
  }

  if (message.type === 'leave_room') {
    if (!peer.room || !peer.sideId) {
      peer.send({ type: 'room_left' });
      return;
    }
    const roomCode = peer.room.code;
    leaveRoom(peer, 'leave');
    peer.send({ type: 'room_left', roomCode });
    return;
  }

  if (message.type === 'command') {
    if (!peer.room || !peer.sideId) return peer.send({ type: 'error', message: '尚未加入房間' });
    peer.room.acceptCommand(peer, message.command);
    return;
  }

  if (message.type === 'ping') {
    peer.send({ type: 'pong', now: Date.now() });
  }
}

function clearPeerRoomState(peer) {
  if (!peer) return;
  peer.room = null;
  peer.sideId = null;
  peer.player = null;
  peer.ready = false;
}

function leaveRoom(peer, reason = 'disconnect') {
  const room = peer.room;
  const sideId = peer.sideId;
  if (!room || !sideId) {
    clearPeerRoomState(peer);
    return;
  }

  const otherSide = sideId === 'player' ? 'rival' : 'player';
  const otherPeer = room.peers[otherSide];
  room.peers[sideId] = null;
  room.players[sideId] = null;
  room.ready[sideId] = false;
  clearPeerRoomState(peer);

  if (room.status === 'closed') return;

  if (room.status === 'waiting' && sideId === 'rival' && room.peers.player) {
    room.ready.player = false;
    room.peers.player.ready = false;
    room.peers.player.send({
      type: 'peer_left',
      roomCode: room.code,
      message: reason === 'leave' ? '對手已退出房間，可以繼續等待' : '對手已離線，可以繼續等待'
    });
    room.broadcastState();
    console.log(`[房間 ${room.code}] 加入者已離開，房主繼續等待`);
    return;
  }

  if (otherPeer) {
    room.peers[otherSide] = null;
    room.players[otherSide] = null;
    room.ready[otherSide] = false;
    clearPeerRoomState(otherPeer);
    otherPeer.send({
      type: 'room_closed',
      roomCode: room.code,
      message: room.status === 'waiting' ? '房主已退出房間' : '對手已退出，聯機戰局已結束'
    });
  }

  room.stop();
  rooms.delete(room.code);
  console.log(`[房間 ${room.code}] 已關閉`);
}

function detachPeer(peer) {
  peers.delete(peer);
  leaveRoom(peer, 'disconnect');
}

function lanAddresses() {
  const values = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family === 'IPv4' && !info.internal) values.push(info.address);
    }
  }
  return [...new Set(values)];
}


const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const peer of peers) {
    if (peer.closed) {
      peers.delete(peer);
      continue;
    }
    if (now - peer.lastPongAt > PEER_TIMEOUT_MS) {
      peer.close();
      continue;
    }
    try { peer.sendPing(); } catch { peer.close(); }
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在關閉聯機房間…`);
  clearInterval(heartbeatTimer);
  for (const room of rooms.values()) {
    room.broadcast({ type: 'server_shutdown', reason: 'deploy' });
    room.stop();
  }
  rooms.clear();
  for (const peer of [...peers]) peer.close(true);
  const forceTimer = setTimeout(() => process.exit(0), 10000);
  forceTimer.unref?.();
  server.close(() => process.exit(0));
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('還不快救主！聯機伺服器已啟動');
  console.log(`電腦本機：http://127.0.0.1:${PORT}`);
  for (const address of lanAddresses()) console.log(`同一 Wi-Fi 手機：http://${address}:${PORT}`);
  console.log('關閉此視窗即可停止伺服器。');
  console.log('');
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
