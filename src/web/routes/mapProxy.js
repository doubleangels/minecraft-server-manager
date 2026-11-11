'use strict';

// Authenticated reverse proxy for BlueMap's web UI: the map port is never
// exposed to the browser directly - everything flows through the panel's
// /map/<serverId>/t/<token>/… path. Plain stdlib http, GET/HEAD only.
//
// Isolation: BlueMap's web files live in the server's data folder, so anyone
// who can edit that folder (a files or content grant, or any mod in the
// container) controls the HTML and script served here. It must never run with
// the panel's session. So this router is mounted BEFORE requireAuth and
// authenticates by a short-lived token in the path (services/mapToken.js),
// minted by the Map tab after its view check; the iframe is sandboxed without
// allow-same-origin; and every response carries a CSP sandbox, so even a
// direct visit runs in an opaque origin that cannot read panel cookies or call
// the panel's API as the signed-in user.
//
// BlueMap's HOST-published port (127.0.0.1 bare metal, host.docker.internal
// when the panel is containerized - see config.mapProxyHost) is only ONE of
// several ways this proxy might actually reach it. A server whose Docker
// network was set (Advanced Docker Settings - e.g. a network shared with a
// reverse proxy like Pangolin) is reachable directly on its CONTAINER port
// over that network, with no host-port-publish involved at all - and if the
// panel container is ALSO joined to that network, that direct path is both
// more robust and required (the host-port path may not reach it at all in
// that topology). So on each server we try candidate targets in order -
// every network IP the sibling container has, THEN the host-published-port
// fallback - cache whichever one actually answers, and only re-probe when
// the cached one stops working (a fresh probe on every tile/asset request
// would be far too slow).

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const config = require('../../config');
const logger = require('../../logger')(path.basename(__filename));
const { getDocker } = require('../../docker/connect');
const containers = require('../../docker/containers');
const { getMapConfig, BLUEMAP_CONTAINER_PORT } = require('../../services/map');
const { getServer } = require('../../services/servers');
const permissions = require('../../services/permissions');
const mapToken = require('../../services/mapToken');
const { getUser } = require('../../services/auth');

const router = express.Router();

const CONTAINER_PORT = parseInt(BLUEMAP_CONTAINER_PORT, 10); // '8100/tcp' -> 8100
const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 1500;
// Pages larger than this are passed through untouched instead of buffered.
const HTML_INJECT_MAX = 2 * 1024 * 1024;

// Applied to every proxied response, replacing the panel's own CSP: an opaque
// origin (sandbox without allow-same-origin), anything BlueMap needs inside it,
// and framing by the panel only.
const MAP_CSP = [
  'sandbox allow-scripts',
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
  "frame-ancestors 'self'",
].join('; ');

// BlueMap reads and writes localStorage without a guard, and an opaque origin
// has none (access throws), so its pages get an in-memory stand-in first. Its
// settings then last for the open tab only.
const STORAGE_SHIM =
  '<script>(function(){try{window.localStorage.getItem("msm")}catch(e){var m={};var s={' +
  'getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},' +
  'setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},' +
  'key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};' +
  'try{Object.defineProperty(window,"localStorage",{value:s,configurable:true})}catch(_){}}})();</script>';

function injectShim(html) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + STORAGE_SHIM + html.slice(head.index + head[0].length);
  return STORAGE_SHIM + html;
}

// serverId -> { target: {host, port}, expiresAt }
const targetCache = new Map();

/** Every network IP the sibling container has, on its own CONTAINER port - no
 *  host-port-publish or host-gateway routing needed if the panel can reach it. */
async function containerNetworkTargets(server) {
  const ref = containers.containerRef(server.id);
  try {
    const info = await getDocker().getContainer(ref).inspect();
    const nets = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
    return Object.values(nets)
      .map((n) => n.IPAddress)
      .filter(Boolean)
      .map((ip) => ({ host: ip, port: CONTAINER_PORT }));
  } catch {
    // container gone/uninspectable - fall through to the host-port candidate
    logger.debug('Could not inspect a container while resolving map proxy targets.', { serverId: server.id });
    return [];
  }
}

/** Raw TCP connect probe - cheap, and sidesteps whether BlueMap's bundled
 *  webserver implements any particular HTTP method correctly. */
function probeConnect(target, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function resolveTarget(server, cfg) {
  const cached = targetCache.get(server.id);
  if (cached && cached.expiresAt > Date.now()) return cached.target;

  const candidates = [...(await containerNetworkTargets(server)), { host: config.mapProxyHost, port: cfg.hostPort }];
  for (const target of candidates) {
    if (await probeConnect(target)) {
      targetCache.set(server.id, { target, expiresAt: Date.now() + CACHE_TTL_MS });
      return target;
    }
  }
  // Nothing answered - return the last (host-port) candidate so the error
  // message below at least reflects the "final" attempt, uncached (so the
  // very next request re-probes everything instead of being stuck on a dead
  // target for the full TTL).
  return candidates[candidates.length - 1];
}

function setMapHeaders(res) {
  res.setHeader('Content-Security-Policy', MAP_CSP);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
}

router.use(
  '/:id/t/:token',
  asyncHandler(async (req, res) => {
    setMapHeaders(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      logger.debug('Rejected a non-GET request to the map proxy.', { serverId: req.params.id, method: req.method });
      return res.status(405).send('Method not allowed');
    }
    const userId = mapToken.verify(req.params.token, req.params.id);
    const user = userId ? getUser(userId) : null;
    if (!user) {
      logger.debug('Rejected a map proxy request with a missing or expired token.', { serverId: req.params.id });
      return res.status(403).send('This map link has expired. Reload the Map tab.');
    }
    const server = getServer(req.params.id);
    const visible = server && permissions.can(user, server.id, 'view');
    const cfg = visible ? getMapConfig(server.id) : { enabled: false };
    if (!server || !visible || !cfg.enabled || !cfg.hostPort) {
      logger.debug('Rejected a map proxy request for a server without a live map.', { serverId: req.params.id });
      return res.status(404).send('Live map is not enabled for this server');
    }

    const target = await resolveTarget(server, cfg);

    // BlueMap's bundled webserver only serves static tiles/assets, so forward a
    // small allowlist of request headers rather than the client's whole set -
    // nothing else (cookies, auth, x-forwarded-*, custom headers) has any business
    // reaching a target that may sit on a shared Docker network.
    const FORWARD_REQ = ['accept', 'accept-encoding', 'accept-language', 'range', 'if-none-match', 'if-modified-since'];
    const fwd = { host: `${target.host}:${target.port}` };
    for (const h of FORWARD_REQ) if (req.headers[h] != null) fwd[h] = req.headers[h];
    // Pages get the storage shim, so ask for them uncompressed and whole.
    const pagePath = /(?:\/|\.html?)$/i.test(req.path);
    if (pagePath) {
      delete fwd['accept-encoding'];
      delete fwd.range;
    }

    // Symmetrically, copy back only headers a static asset legitimately needs -
    // never a Set-Cookie / CSP / auth header BlueMap might emit.
    const COPY_RES = new Set([
      'content-type',
      'content-length',
      'content-encoding',
      'content-range',
      'accept-ranges',
      'cache-control',
      'last-modified',
      'etag',
      'expires',
      'vary',
    ]);

    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        path: req.url === '/' ? '/' : req.url,
        method: req.method,
        headers: fwd,
        timeout: 20000,
      },
      (up) => {
        res.status(up.statusCode || 502);
        for (const [k, v] of Object.entries(up.headers)) {
          if (COPY_RES.has(k.toLowerCase())) res.setHeader(k, v);
        }
        const isHtml = /^text\/html/i.test(String(up.headers['content-type'] || ''));
        const plain = !up.headers['content-encoding'] || up.headers['content-encoding'] === 'identity';
        const size = Number(up.headers['content-length'] || 0);
        if (!isHtml || !plain || req.method === 'HEAD' || size > HTML_INJECT_MAX) return up.pipe(res);
        const chunks = [];
        let total = 0;
        up.on('data', (c) => {
          total += c.length;
          if (total > HTML_INJECT_MAX) {
            up.destroy(new Error('map page too large'));
            return;
          }
          chunks.push(c);
        });
        up.on('end', () => {
          const body = Buffer.from(injectShim(Buffer.concat(chunks).toString('utf8')));
          res.removeHeader('etag');
          res.setHeader('Content-Length', body.length);
          res.end(body);
        });
      }
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (err) => {
      targetCache.delete(server.id); // stale - the next request re-probes every candidate
      logger.warn('A live-map proxy request failed.', {
        serverId: server.id,
        target: `${target.host}:${target.port}`,
        code: err.code || 'timeout',
      });
      if (res.headersSent) return res.end();
      if (err.code === 'ENOTFOUND') {
        return res
          .status(502)
          .send(
            `Cannot resolve the map-proxy host "${target.host}". If the panel runs in its own container, ` +
              'add `extra_hosts: ["host.docker.internal:host-gateway"]` to its compose service ' +
              '(see docker-compose.yml), or set MAP_PROXY_HOST explicitly.'
          );
      }
      res
        .status(502)
        .send(
          'The map server is not responding. Is the Minecraft server running? BlueMap needs a minute after startup to come up.'
        );
    });
    req.pipe(upstream);
  })
);

// Anything else under /map (the old session-cookie URL, or a missing token)
// is refused: the map only loads through a token.
router.use((req, res) => {
  setMapHeaders(res);
  logger.debug('Rejected a map proxy request without a token.', { path: req.path });
  res.status(403).send('Open the map from its server page.');
});

module.exports = router;
