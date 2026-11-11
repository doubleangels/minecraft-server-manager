'use strict';

// Process lifecycle: request timeouts, the fault policy, and a clean stop on
// SIGTERM. The fault and shutdown checks run real child processes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function childEnv(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-life-'));
  return {
    dataDir,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      SESSION_SECRET: 'lifecycle-test-secret-0123456789abcdef',
      LOG_PRETTY: 'false',
      LOG_LEVEL: 'info',
      NODE_ENV: 'test',
      DOCKER_HOST: 'tcp://127.0.0.1:1',
      ...extra,
    },
  };
}

function run(args, env, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

test('the HTTP server allows long uploads but keeps a header timeout', () => {
  const { configureHttpServer } = require('../src/lifecycle');
  const server = configureHttpServer(http.createServer());
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.headersTimeout, 60_000);
});

test('the fault policy exits on exceptions by default, with opt-outs', () => {
  const { faultPolicy } = require('../src/lifecycle');
  assert.deepEqual(faultPolicy({}), { exitOnException: true, exitOnRejection: false });
  assert.deepEqual(faultPolicy({ MSM_KEEP_ALIVE_ON_FATAL: '1' }), { exitOnException: false, exitOnRejection: false });
  assert.deepEqual(faultPolicy({ MSM_EXIT_ON_FATAL: 'true' }), { exitOnException: true, exitOnRejection: true });
});

const GUARD_SCRIPT = `
  const life = require('./src/lifecycle');
  life.installRuntimeGuards({ exit: (c) => process.exit(c) });
  setTimeout(() => { throw new Error('boom in a timer'); }, 10);
  setTimeout(() => { Promise.reject(new Error('lost promise')); }, 20);
  setTimeout(() => process.exit(0), 300);
`;

test('a thrown error in a timer exits the process by default', async () => {
  const { env, dataDir } = childEnv();
  try {
    const r = await run(['-e', GUARD_SCRIPT], env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /panel is exiting to restart clean/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('MSM_KEEP_ALIVE_ON_FATAL=1 keeps the process running after a thrown error', async () => {
  const { env, dataDir } = childEnv({ MSM_KEEP_ALIVE_ON_FATAL: '1' });
  try {
    const r = await run(['-e', GUARD_SCRIPT], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /kept the panel running/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('SIGTERM stops the panel cleanly in under 10 seconds with the WAL checkpointed', async () => {
  const port = await freePort();
  const { env, dataDir } = childEnv({ PANEL_PORT: String(port), PANEL_HOST: '127.0.0.1' });
  try {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    // Wait until it serves, then hold a request open over a keep-alive socket.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (/The panel is listening/.test(out)) break;
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        assert.fail(`the panel never started:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.status);
    assert.equal(ok, 200);
    const started = Date.now();
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const code = await exited;
    clearTimeout(kill);
    assert.equal(code, 0, out);
    assert.ok(Date.now() - started < 10_000, 'stopped in under 10 s');
    assert.match(out, /The panel stopped cleanly/);
    const wal = path.join(dataDir, 'panel.db-wal');
    assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'no WAL content left pending');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
