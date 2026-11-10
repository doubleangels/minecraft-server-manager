'use strict';

// A direct RCON client for the panel's own high-frequency polls (player list,
// TPS). Each poll used to be a `docker exec rcon-cli`, which spawns a process
// inside the Minecraft container (charged to that server's CPU and memory
// allowance), costs the Docker daemon an exec round trip, and makes the server
// log two "Thread RCON Client started/shut down" lines. About 15 a minute per
// running server. One authenticated TCP connection per server, kept open,
// replaces all of that.
//
// The connection goes to the server's published RCON port on the same host the
// live-map proxy uses (config.mapProxyHost: 127.0.0.1 when the panel runs on
// the host, host.docker.internal when it runs in Docker). Callers fall back to
// rcon-cli when this throws, so an unusual network setup degrades to the old
// behavior instead of breaking.
//
// Wire format (Source RCON): int32 LE length, int32 id, int32 type, ASCII body,
// two NUL bytes. Types: 3 = auth, 2 = command, 0 = response.

const net = require('node:net');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const secrets = require('./secrets');
const logger = require('../logger')(path.basename(__filename));

const CONNECT_TIMEOUT_MS = 2000;
const COMMAND_TIMEOUT_MS = 5000;
// Minecraft splits a long reply into 4096-byte packets with no end marker. A
// shorter packet ends the reply; after a full-size one, wait this long for more.
const MAX_PACKET_BODY = 4096;
const FRAGMENT_WAIT_MS = 80;
// After a failed direct attempt, use the fallback for a while before retrying.
const RETRY_AFTER_MS = 60_000;
const AUTH_RETRY_AFTER_MS = 10 * 60_000;

/** @type {Map<string, {conn: RconConnection | null, key: string, retryAt: number}>} */
const pool = new Map();

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf; // the two trailing NULs are already zero
}

class RconConnection {
  /** @param {string} host @param {number} port */
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    /** @type {null | ((pkt: {id: number, type: number, body: string}) => void)} */
    this.onPacket = null;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  /** Connect and authenticate. */
  async open(password) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('RCON connect timed out.'));
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      socket.on('data', (chunk) => this.receive(chunk));
      socket.on('close', () => {
        this.closed = true;
      });
      socket.on('error', () => {
        this.closed = true;
      });
      this.socket = socket;
    });
    const id = this.nextId++;
    const reply = await this.request(id, 3, password, (pkt) => pkt.type === 2);
    if (reply.id === -1) {
      const err = new Error('RCON authentication failed.');
      // @ts-ignore - tagged for the caller's backoff
      err.auth = true;
      throw err;
    }
  }

  receive(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (len < 10 || len > 1_048_576) {
        this.close(); // garbage on the wire: drop the connection
        return;
      }
      if (this.buf.length < 4 + len) return;
      const pkt = {
        id: this.buf.readInt32LE(4),
        type: this.buf.readInt32LE(8),
        body: this.buf.subarray(12, 4 + len - 2).toString('utf8'),
      };
      this.buf = this.buf.subarray(4 + len);
      if (this.onPacket) this.onPacket(pkt);
    }
  }

  /** Send one packet and resolve with the first matching reply. */
  request(id, type, body, match) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onPacket = null;
        this.close();
        reject(new Error('RCON reply timed out.'));
      }, COMMAND_TIMEOUT_MS);
      this.onPacket = (pkt) => {
        if (!match(pkt)) return;
        clearTimeout(timer);
        this.onPacket = null;
        resolve(pkt);
      };
      this.socket.write(encode(id, type, body));
    });
  }

  /** Run a command; commands on one connection run one at a time. */
  command(text) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (this.closed) return reject(new Error('RCON connection is closed.'));
        const id = this.nextId++;
        const parts = [];
        let idle = null;
        const timer = setTimeout(() => {
          this.onPacket = null;
          this.close();
          reject(new Error('RCON reply timed out.'));
        }, COMMAND_TIMEOUT_MS);
        const finish = () => {
          clearTimeout(timer);
          if (idle) clearTimeout(idle);
          this.onPacket = null;
          resolve(parts.join(''));
        };
        this.onPacket = (pkt) => {
          if (pkt.id !== id) return;
          parts.push(pkt.body);
          if (idle) clearTimeout(idle);
          if (Buffer.byteLength(pkt.body) < MAX_PACKET_BODY) finish();
          else idle = setTimeout(finish, FRAGMENT_WAIT_MS);
        };
        this.socket.write(encode(id, 2, text));
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close() {
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run an RCON command on a server over the direct connection. Throws when the
 * direct route is unavailable (not reachable, still booting, recently failed),
 * so the caller can fall back to rcon-cli.
 * @param {string} serverId
 * @param {string[]} words command and arguments, as rcon-cli would take them
 * @returns {Promise<string>} the server's reply
 */
async function rconCommand(serverId, words) {
  const row = db.get(
    'SELECT port_rcon, rcon_password_cipher FROM servers WHERE id = ? AND deleted_at IS NULL',
    serverId
  );
  if (!row || !row.port_rcon) throw new Error('No RCON port for this server.');
  const password = secrets.tryDecrypt(row.rcon_password_cipher);
  if (!password) throw new Error('The RCON password could not be read.');
  // Reconnect if the port or password changed (a port move, a regenerated password).
  const key = `${config.mapProxyHost}:${row.port_rcon}:${row.rcon_password_cipher}`;
  let slot = pool.get(serverId);
  if (slot && slot.key !== key) {
    slot.conn?.close();
    slot = undefined;
  }
  if (!slot) {
    slot = { conn: null, key, retryAt: 0 };
    pool.set(serverId, slot);
  }
  if (!slot.conn || slot.conn.closed) {
    if (Date.now() < slot.retryAt) throw new Error('The direct RCON route is backing off.');
    const conn = new RconConnection(config.mapProxyHost, row.port_rcon);
    try {
      await conn.open(password);
    } catch (err) {
      conn.close();
      // @ts-ignore - set by open() on a rejected password
      slot.retryAt = Date.now() + (err.auth ? AUTH_RETRY_AFTER_MS : RETRY_AFTER_MS);
      logger.debug('The direct RCON connection could not be opened, so polls use rcon-cli for now.', {
        serverId,
        host: config.mapProxyHost,
        port: row.port_rcon,
        err: err.message,
      });
      throw err;
    }
    slot.conn = conn;
    logger.debug('Opened a direct RCON connection.', { serverId, host: config.mapProxyHost, port: row.port_rcon });
  }
  const text = words.map(String).join(' ');
  try {
    return await slot.conn.command(text);
  } catch (err) {
    slot.conn.close();
    slot.conn = null;
    throw err;
  }
}

/** Close a server's direct connection (it stopped, or the panel stops polling it). */
function closeRcon(serverId) {
  const slot = pool.get(serverId);
  if (!slot) return;
  slot.conn?.close();
  pool.delete(serverId);
}

module.exports = { rconCommand, closeRcon, encode, RconConnection };
