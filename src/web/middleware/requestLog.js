'use strict';

// Access log. One line per request, emitted on `res` finish so it carries the
// final status and duration. Static assets and the health probe are skipped so
// the log stays signal. The 5xx line is logged at `warn` WITHOUT a stack - the
// JSON/HTML error handlers own the `error` line and the stack trace, so this one
// only records that a request ended badly.

const { randomUUID } = require('node:crypto');
const logger = require('../../logger')('http');
const { summarizeBody, sanitizeLogMeta } = require('../../utils/logSanitize');

const SKIP_EXACT = new Set(['/healthz', '/favicon.ico']);
const SKIP_PREFIX = ['/css/', '/js/', '/fonts/', '/icons/', '/vendor/', '/assets/'];

// A client-supplied request id is echoed into a response header, so it must be
// header-safe: a CR/LF in it would make res.setHeader throw ERR_INVALID_CHAR and
// turn every such request into a 500. Anything that isn't a short, plain token is
// dropped in favour of a fresh UUID.
const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

// Requests whose whole body is a credential (sign-in, first-run setup, 2FA,
// password changes, API keys and tokens): their bodies are never logged, not
// even redacted. Every other write logs a sanitized summary of its body.
const NO_BODY = /\/(login|logout|setup|totp|2fa|password|api-tokens|keys)(\/|$)/i;

// Polled endpoints (the task tray, live status, health) answer every few
// seconds per open tab: debug, so the info log stays a record of actions.
const POLLED = /^\/api\/(tasks|servers\/live|health|servers\/[^/]+\/(live|status|stats))(\/|$)/;

function shouldSkip(pathname) {
  if (SKIP_EXACT.has(pathname)) return true;
  return SKIP_PREFIX.some((p) => pathname.startsWith(p));
}

function resolveRequestId(raw) {
  return typeof raw === 'string' && SAFE_REQUEST_ID.test(raw) ? raw : randomUUID();
}

/** Names and sizes of multer uploads (never their contents). */
function uploadedFiles(req) {
  const list = [];
  if (req.file) list.push(req.file);
  if (Array.isArray(req.files)) list.push(...req.files);
  else if (req.files && typeof req.files === 'object')
    for (const v of Object.values(req.files)) list.push(...[].concat(v));
  if (!list.length) return undefined;
  return list.slice(0, 20).map((f) => ({ name: f.originalname, bytes: f.size, type: f.mimetype }));
}

module.exports = function requestLog(req, res, next) {
  if (shouldSkip(req.path)) return next();

  const start = process.hrtime.bigint();
  const requestId = resolveRequestId(req.headers['x-request-id']);
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  let logged = false;
  const emit = (aborted) => {
    if (logged) return;
    logged = true;
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    const status = res.statusCode;
    const pathOnly = req.originalUrl.split('?')[0];
    const write = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const files = uploadedFiles(req);
    const meta = {
      method: req.method,
      path: pathOnly,
      query: req.query && Object.keys(req.query).length ? sanitizeLogMeta(req.query) : undefined,
      body: write && !NO_BODY.test(pathOnly) ? summarizeBody(req.body) : undefined,
      files,
      status,
      durationMs,
      responseBytes: Number(res.getHeader('content-length')) || undefined,
      requestId,
      userId: req.user ? req.user.id : undefined,
      username: req.user ? req.user.username : undefined,
      role: req.user ? req.user.role : undefined,
      viaApiToken: req.apiToken ? true : undefined,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 160) || undefined,
      aborted: aborted || undefined,
    };
    const level =
      aborted || status >= 500
        ? 'warn'
        : status === 404 || status === 401 || (!write && POLLED.test(pathOnly))
          ? 'debug'
          : 'info';
    logger[level](aborted ? 'A request was aborted before it finished.' : 'Handled a request.', meta);
  };

  // 'finish' = response fully flushed; 'close' without 'finish' = client hung up.
  res.on('finish', () => emit(false));
  res.on('close', () => emit(!res.writableFinished));

  next();
};
