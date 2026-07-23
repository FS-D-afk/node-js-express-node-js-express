const attempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function requestKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function pruneExpired(now = Date.now()) {
  for (const [key, value] of attempts.entries()) {
    if (value.startedAt + WINDOW_MS <= now) attempts.delete(key);
  }
}

function currentAttempt(key, now = Date.now()) {
  const current = attempts.get(key);
  if (!current || current.startedAt + WINDOW_MS <= now) {
    attempts.delete(key);
    return null;
  }
  return current;
}

function registerFailure(key, now = Date.now()) {
  const current = currentAttempt(key, now);
  if (current) {
    current.count += 1;
  } else {
    attempts.set(key, { count: 1, startedAt: now });
  }
}

function isLimited(key, now = Date.now()) {
  const current = currentAttempt(key, now);
  return Boolean(current && current.count >= MAX_ATTEMPTS);
}

function clearFailures(key) {
  attempts.delete(key);
}

function adminLoginRateLimit(req, res, next) {
  if (String(req.method || '').toUpperCase() !== 'POST') return next();

  pruneExpired();
  const key = requestKey(req);
  if (isLimited(key)) {
    req.session.flash = {
      type: 'error',
      message: '后台登录尝试次数过多，请 15 分钟后再试。',
    };
    return res.redirect('/admin/login');
  }

  const originalRedirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    const destination = String(args[args.length - 1] || '');
    if (destination === '/admin/login') registerFailure(key);
    if (destination === '/admin') clearFailures(key);
    return originalRedirect(...args);
  };

  return next();
}

module.exports = {
  MAX_ATTEMPTS,
  WINDOW_MS,
  adminLoginRateLimit,
  clearFailures,
  isLimited,
  registerFailure,
};
