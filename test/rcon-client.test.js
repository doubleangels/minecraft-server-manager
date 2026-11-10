'use strict';

// The direct RCON client that replaced `docker exec rcon-cli` for the live
// polls: one authenticated connection per server, reused, with long replies
// reassembled and a wrong password backed off instead of retried every poll.

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const db = require('../src/db');
const secrets = require('../src/services/secrets');
const config = require('../src/config');
const { rconCommand, closeRcon, encode } = require('../src/services/rconClient');

const SID = 'srv_rconclient';
const PASSWORD = 'hunter2-rcon';
let fake;
let connections = 0;

/** A minimal Minecraft-style RCON server. */
function startFake() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      connections++;
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
          const len = buf.readInt32LE(0);
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.subarray(12, 4 + len - 2).toString('utf8');
          buf = buf.subarray(4 + len);
          if (type === 3) sock.write(encode(body === PASSWORD ? id : -1, 2, ''));
          else if (body === 'list') sock.write(encode(id, 0, 'There are 1 of a max of 20 players online: Steve'));
          else if (body === 'long') {
            // Minecraft splits long replies into 4096-byte packets.
            sock.write(encode(id, 0, 'a'.repeat(4096)));
            setTimeout(() => sock.write(encode(id, 0, 'b'.repeat(10))), 10);
          } else sock.write(encode(id, 0, `Unknown command: ${body}`));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test.before(async () => {
  await app.start();
  fake = await startFake();
  app.seedServer(SID);
  db.run(
    'UPDATE servers SET port_rcon = ?, rcon_password_cipher = ? WHERE id = ?',
    fake.address().port,
    secrets.encrypt(PASSWORD),
    SID
  );
});
test.after(async () => {
  closeRcon(SID);
  fake.close();
  await app.stop();
});

test('the panel reaches published ports on this machine in tests', () => {
  assert.equal(config.mapProxyHost, '127.0.0.1');
});

test('commands run over one kept-open, authenticated connection', async () => {
  assert.equal(await rconCommand(SID, ['list']), 'There are 1 of a max of 20 players online: Steve');
  assert.equal(await rconCommand(SID, ['tps']), 'Unknown command: tps');
  // Concurrent commands queue on the same connection instead of opening more.
  const [a, b] = await Promise.all([rconCommand(SID, ['list']), rconCommand(SID, ['mspt'])]);
  assert.match(a, /Steve/);
  assert.equal(b, 'Unknown command: mspt');
  assert.equal(connections, 1);
});

test('a reply split across 4096-byte packets is reassembled', async () => {
  const out = await rconCommand(SID, ['long']);
  assert.equal(out.length, 4106);
  assert.ok(out.endsWith('bbbbbbbbbb'));
});

test('a rejected password backs off instead of retrying on every poll', async () => {
  closeRcon(SID);
  db.run('UPDATE servers SET rcon_password_cipher = ? WHERE id = ?', secrets.encrypt('wrong'), SID);
  const before = connections;
  await assert.rejects(rconCommand(SID, ['list']), /authentication failed/);
  await assert.rejects(rconCommand(SID, ['list']), /backing off/);
  assert.equal(connections, before + 1);
  closeRcon(SID);
  db.run('UPDATE servers SET rcon_password_cipher = ? WHERE id = ?', secrets.encrypt(PASSWORD), SID);
});

test('an unreachable port fails fast so the caller can fall back to rcon-cli', async () => {
  closeRcon(SID);
  db.run('UPDATE servers SET port_rcon = 1 WHERE id = ?', SID);
  const t0 = Date.now();
  await assert.rejects(rconCommand(SID, ['list']));
  assert.ok(Date.now() - t0 < 2500);
  closeRcon(SID);
  db.run('UPDATE servers SET port_rcon = ? WHERE id = ?', fake.address().port, SID);
});
