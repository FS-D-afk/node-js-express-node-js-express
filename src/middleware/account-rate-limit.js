const buckets = new Map();

const LOGIN_EMAIL_MAX_ATTEMPTS = 8;
const LOGIN_IP_MAX_ATTEMPTS = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_IP_MAX_ATTEMPTS = 5;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_BUCKETS = 10000;

function clientAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function pruneExpired(now = Date.now()) {
  for (const [key, value] of buckets.entries()) {
    if (value.expiresAt <= now) buckets.delete(key);
  }

  if (buckets.size <= MAX_BUCKETS) return;
  const overflow = buckets.size - MAX_BUCKETS;
  const oldest = [...buckets.entries()]
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, overflow);
  for (const [key] of oldest) buckets.delete(key);
}

function currentBucket(key, now = Date.now()) {
  const current = buckets.get(key);
  if (!current || current.expiresAt <= now) {
    buckets.delete(key);
    return null;
  }
  return current;
}

function increment(key, windowMs, now = Date.now()) {
  pruneExpired(now);
  const current = currentBucket(key, now);
  if (current) {
    current.count += 1;
    current.updatedAt = now;
    return current.count;
  }

  buckets.set(key, {
    count: 1,
    expiresAt: now + windowMs,
    updatedAt: now,
  });
  return 1;
}

function isLimited(key, maximum, now = Date.now()) {
  pruneExpired(now);
  const current = currentBucket(key, now);
  return Boolean(current && current.count >= maximum);
}

function clear(key) {
  buckets.delete(key);
}

function loginEmailKey(req, email) {
  return `login-email:${clientAddress(req)}:${String(email || '').trim().toLowerCase()}`;
}

function loginIpKey(req) {
  return `login-ip:${clientAddress(req)}`;
}

function registrationIpKey(req) {
  return `registration-ip:${clientAddress(req)}`;
}

function isLoginLimited(req, email, now = Date.now()) {
  return isLimited(loginEmailKey(req, email), LOGIN_EMAIL_MAX_ATTEMPTS, now)
    || isLimited(loginIpKey(req), LOGIN_IP_MAX_ATTEMPTS, now);
}

function registerLoginFailure(req, email, now = Date.now()) {
  increment(loginEmailKey(req, email), LOGIN_WINDOW_MS, now);
  increment(loginIpKey(req), LOGIN_WINDOW_MS, now);
}

function clearLoginFailures(req, email) {
  clear(loginEmailKey(req, email));
}

function isRegistrationLimited(req, now = Date.now()) {
  return isLimited(registrationIpKey(req), REGISTRATION_IP_MAX_ATTEMPTS, now);
}

function registerRegistrationAttempt(req, now = Date.now()) {
  return increment(registrationIpKey(req), REGISTRATION_WINDOW_MS, now);
}

function resetAccountRateLimits() {
  buckets.clear();
}

module.exports = {
  LOGIN_EMAIL_MAX_ATTEMPTS,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  REGISTRATION_IP_MAX_ATTEMPTS,
  REGISTRATION_WINDOW_MS,
  clearLoginFailures,
  isLoginLimited,
  isRegistrationLimited,
  registerLoginFailure,
  registerRegistrationAttempt,
  resetAccountRateLimits,
};
