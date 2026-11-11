'use strict';

// Where the panel-only ports (RCON, BlueMap's web server) are published.
// Docker publishes a port on every interface unless told otherwise, and its
// rules bypass host firewalls such as ufw, so RCON (plaintext, full operator)
// and the raw map would be open to the LAN and often the internet. These two
// ports exist only for the panel, so they are published on the one address
// the panel reaches them on:
//   - panel on the host: 127.0.0.1
//   - panel in a container: the Docker bridge gateway, which is where
//     host.docker.internal (host-gateway) points from inside the panel
//   - an explicit MAP_PROXY_HOST IP: that IP
// INTERNAL_PORT_BIND overrides it ('all' for every interface, or an IP).
// The game, query, Bedrock and admin-added extra ports stay public.

const net = require('node:net');
const path = require('node:path');
const config = require('../config');
const logger = require('../logger')(path.basename(__filename));

let gatewayCache = null;

async function bridgeGateway() {
  if (gatewayCache) return gatewayCache;
  const { getDocker } = require('./connect');
  const info = await getDocker().getNetwork('bridge').inspect();
  const gw = ((info.IPAM && info.IPAM.Config) || []).map((c) => c.Gateway).find((g) => g && net.isIPv4(g));
  if (gw) gatewayCache = gw;
  return gw || null;
}

/**
 * The host IP to publish panel-only ports on, or null for every interface.
 * @param {{ mode?: string, proxyHost?: string, gateway?: () => Promise<string|null> }} [opts] for tests
 * @returns {Promise<string|null>}
 */
async function internalBindIp({
  mode = config.internalPortBind,
  proxyHost = config.mapProxyHost,
  gateway = bridgeGateway,
} = {}) {
  if (mode === 'all') return null;
  if (mode !== 'auto') {
    if (net.isIP(mode)) return mode;
    logger.warn('INTERNAL_PORT_BIND is not auto, all, or an IP address, so auto is used.', { value: mode });
  }
  if (net.isIP(proxyHost)) return proxyHost;
  if (proxyHost === 'host.docker.internal') {
    try {
      const gw = await gateway();
      if (gw) return gw;
    } catch (err) {
      logger.warn('Could not read the Docker bridge gateway, so RCON and map ports stay on every interface.', {
        err: err.message,
      });
      return null;
    }
  }
  logger.warn(
    'Could not tell which address the panel reaches servers on, so RCON and map ports stay on every interface.',
    {
      mapProxyHost: proxyHost,
    }
  );
  return null;
}

/**
 * Flag every server for a rebuild when the bind policy differs from the one
 * its container was made under, so the change shows as a pending one.
 * Containers made before this setting existed published on every interface.
 */
function syncBindPolicy() {
  const db = require('../db');
  const settings = require('../services/settings');
  const policy = config.internalPortBind;
  const last = settings.get('internal_port_bind_policy', 'all');
  if (last === policy) return 0;
  const { changes } = db.run(
    'UPDATE servers SET pending_recreate = 1 WHERE deleted_at IS NULL AND container_id IS NOT NULL'
  );
  settings.set('internal_port_bind_policy', policy);
  if (changes) {
    logger.info('Flagged servers for a rebuild so their RCON and map ports follow the new bind policy.', {
      from: last,
      to: policy,
      servers: changes,
    });
  }
  return changes;
}

module.exports = { internalBindIp, syncBindPolicy, _reset: () => (gatewayCache = null) };
