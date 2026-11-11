// The one way page scripts call the panel's JSON API. Each call site used to
// parse JSON, check res.ok and build its own error, with no timeout (a stalled
// request left a busy spinner forever) and no way back to sign-in when the
// session expired (a toast per call instead).
//
//   const data = await api(`/api/servers/${id}/map/enable`, { method: 'POST', action: 'enable the map' });
//
// Resolves with the parsed JSON body. Rejects with an Error whose message is
// ready for a toast (the server's own `error`, else friendlyError), carrying
// `status` and `code`. A 401 sends the browser to sign-in and comes back here
// afterwards. Long uploads and downloads keep their own fetch calls (they
// need progress, or a body that is not JSON).

import { friendlyError } from './errors.js';

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, timeoutMs?: number, action?: string, headers?: Record<string, string> }} [opts]
 */
export async function api(path, { method = 'GET', body, timeoutMs = 30000, action, headers } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw Object.assign(
      new Error(
        timedOut
          ? `${action ? `Couldn't ${action}` : 'That took too long'}: the panel did not answer in time. Please try again.`
          : friendlyError(err, { action })
      ),
      { status: 0, code: timedOut ? 'timeout' : 'network' }
    );
  }
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw Object.assign(new Error(friendlyError(res, { action })), { status: 401, code: 'signed-out' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw Object.assign(new Error(data.error || friendlyError(res, { action })), {
      status: res.status,
      code: data.code,
      data,
    });
  }
  return data;
}
