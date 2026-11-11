'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
const db = require('../src/db');
const containers = require('../src/docker/containers');
const portBind = require('../src/docker/portBind');

const ports = { game: 25565, rcon: 26565, bedrock: 19132 };
const extras = [
  { container: '8100/tcp', host: 8123, internal: true },
  { container: '8080/tcp', host: 8080 },
];

test('RCON and BlueMap are published on the internal address, game and admin ports everywhere', () => {
  const { bindings, exposed } = containers.portSpec(ports, extras, '127.0.0.1');
  assert.deepEqual(bindings['25575/tcp'], [{ HostIp: '127.0.0.1', HostPort: '26565' }]);
  assert.deepEqual(bindings['8100/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8123' }]);
  assert.deepEqual(bindings['25565/tcp'], [{ HostPort: '25565' }]);
  assert.deepEqual(bindings['25565/udp'], [{ HostPort: '25565' }]);
  assert.deepEqual(bindings['19132/udp'], [{ HostPort: '19132' }]);
  assert.deepEqual(bindings['8080/tcp'], [{ HostPort: '8080' }], 'an admin-added extra port stays public');
  assert.ok(exposed['25575/tcp'] && exposed['8100/tcp']);
});

test('INTERNAL_PORT_BIND=all keeps the old every-interface publishing', () => {
  const { bindings } = containers.portSpec(ports, extras, null);
  assert.deepEqual(bindings['25575/tcp'], [{ HostPort: '26565' }]);
  assert.deepEqual(bindings['8100/tcp'], [{ HostPort: '8123' }]);
});

test('the bind address follows where the panel reaches servers', async () => {
  const gw = async () => '172.17.0.1';
  assert.equal(await portBind.internalBindIp({ mode: 'auto', proxyHost: '127.0.0.1', gateway: gw }), '127.0.0.1');
  assert.equal(
    await portBind.internalBindIp({ mode: 'auto', proxyHost: 'host.docker.internal', gateway: gw }),
    '172.17.0.1'
  );
  assert.equal(await portBind.internalBindIp({ mode: 'all', proxyHost: '127.0.0.1', gateway: gw }), null);
  assert.equal(await portBind.internalBindIp({ mode: '10.0.0.2', proxyHost: '127.0.0.1', gateway: gw }), '10.0.0.2');
  // An unknown hostname or an unreadable gateway falls back to every interface rather than breaking RCON.
  assert.equal(await portBind.internalBindIp({ mode: 'auto', proxyHost: 'mc-host.lan', gateway: gw }), null);
  const broken = async () => {
    throw new Error('no docker');
  };
  assert.equal(
    await portBind.internalBindIp({ mode: 'auto', proxyHost: 'host.docker.internal', gateway: broken }),
    null
  );
});

test('server containers get no-new-privileges and a process cap', () => {
  const h = containers.hardening();
  assert.deepEqual(h.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(h.PidsLimit, 4096);
});

test('a changed bind policy flags existing containers for a rebuild, once', () => {
  migrate();
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, mc_version, container_id)
     VALUES ('srv_pb1', 'PB', 'PAPER', 27001, 28001, 'x', 1024, 2048, '1.21.4', 'abc')`
  );
  db.run("DELETE FROM settings WHERE key = 'internal_port_bind_policy'");
  assert.ok(portBind.syncBindPolicy() >= 1);
  assert.equal(db.get("SELECT pending_recreate FROM servers WHERE id = 'srv_pb1'").pending_recreate, 1);
  db.run("UPDATE servers SET pending_recreate = 0 WHERE id = 'srv_pb1'");
  assert.equal(portBind.syncBindPolicy(), 0);
  assert.equal(db.get("SELECT pending_recreate FROM servers WHERE id = 'srv_pb1'").pending_recreate, 0);
});
