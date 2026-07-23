const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `campus-vend-account-security-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = testDbPath;
process.env.SESSION_SECRET = 'account-security-test-secret-at-least-32-characters';
process.env.ADMIN_USERNAME = 'security-admin';
process.env.ADMIN_PASSWORD = 'SecurityAdminPass123!';

for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(`${testDbPath}${suffix}`, { force: true });
}

const {
  LOGIN_EMAIL_MAX_ATTEMPTS,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  REGISTRATION_IP_MAX_ATTEMPTS,
  REGISTRATION_WINDOW_MS,
  isLoginLimited,
  isRegistrationLimited,
  registerLoginFailure,
  registerRegistrationAttempt,
  resetAccountRateLimits,
} = require('../src/middleware/account-rate-limit');
const { adminLoginTimingProtection } = require('../src/middleware/admin-login-timing');
const { securityHeaders } = require('../src/middleware/security-headers');
const { db, initDb } = require('../src/db');
const users = require('../src/services/users');

function closeDb() {
  return new Promise((resolve) => db.close(() => resolve()));
}

function request(ip, pathName = '/') {
  return { ip, path: pathName, originalUrl: pathName, socket: {} };
}

function response() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
  };
}

function runMiddleware(middleware, req, res = response()) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => (error ? reject(error) : resolve(res)));
  });
}

function testRateLimits() {
  const start = 1000000;
  const loginRequest = request('203.0.113.10');

  resetAccountRateLimits();
  for (let index = 0; index < LOGIN_EMAIL_MAX_ATTEMPTS; index += 1) {
    registerLoginFailure(loginRequest, 'target@example.com', start + index);
  }
  if (!isLoginLimited(loginRequest, 'target@example.com', start + LOGIN_EMAIL_MAX_ATTEMPTS)) {
    throw new Error('Per-address and per-email login limit was not enforced');
  }
  if (isLoginLimited(loginRequest, 'other@example.com', start + LOGIN_EMAIL_MAX_ATTEMPTS)) {
    throw new Error('Email-specific limit incorrectly blocked an unrelated email too early');
  }

  resetAccountRateLimits();
  for (let index = 0; index < LOGIN_IP_MAX_ATTEMPTS; index += 1) {
    registerLoginFailure(loginRequest, `candidate-${index}@example.com`, start + index);
  }
  if (!isLoginLimited(loginRequest, 'new-target@example.com', start + LOGIN_IP_MAX_ATTEMPTS)) {
    throw new Error('Global per-address login limit was not enforced');
  }
  if (isLoginLimited(loginRequest, 'new-target@example.com', start + LOGIN_WINDOW_MS + 1)) {
    throw new Error('Expired login limit was not cleared');
  }

  resetAccountRateLimits();
  const registrationRequest = request('203.0.113.20');
  for (let index = 0; index < REGISTRATION_IP_MAX_ATTEMPTS; index += 1) {
    registerRegistrationAttempt(registrationRequest, start + index);
  }
  if (!isRegistrationLimited(registrationRequest, start + REGISTRATION_IP_MAX_ATTEMPTS)) {
    throw new Error('Registration limit was not enforced');
  }
  if (isRegistrationLimited(registrationRequest, start + REGISTRATION_WINDOW_MS + 1)) {
    throw new Error('Expired registration limit was not cleared');
  }
}

function testSecurityHeaders() {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  const sensitiveResponse = response();
  let nextCalled = false;
  securityHeaders(request('203.0.113.30', '/account/password'), sensitiveResponse, () => {
    nextCalled = true;
  });

  if (!nextCalled) throw new Error('Security-header middleware did not continue');
  if (sensitiveResponse.headers.get('x-content-type-options') !== 'nosniff') {
    throw new Error('X-Content-Type-Options header missing');
  }
  if (sensitiveResponse.headers.get('x-frame-options') !== 'DENY') {
    throw new Error('X-Frame-Options header missing');
  }
  if (!sensitiveResponse.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")) {
    throw new Error('Content-Security-Policy frame protection missing');
  }
  if (sensitiveResponse.headers.get('cache-control') !== 'no-store') {
    throw new Error('Sensitive account page should not be cached');
  }
  if (sensitiveResponse.headers.get('strict-transport-security') !== 'max-age=31536000') {
    throw new Error('Production HSTS header missing or over-broad');
  }

  process.env.NODE_ENV = previousEnvironment;
}

(async () => {
  testRateLimits();
  testSecurityHeaders();
  await initDb();

  await runMiddleware(adminLoginTimingProtection, {
    method: 'POST',
    body: { username: 'missing-admin', password: 'WrongPassword123!' },
  });
  await runMiddleware(adminLoginTimingProtection, {
    method: 'POST',
    body: { username: 'security-admin', password: 'WrongPassword123!' },
  });

  let weakPasswordRejected = false;
  try {
    await users.createUser('weak@example.com', 'Only11Chars');
  } catch (error) {
    weakPasswordRejected = /12/.test(error.message);
  }
  if (!weakPasswordRejected) {
    throw new Error('New accounts must require a password of at least 12 characters');
  }

  const user = await users.createUser('secure@example.com', 'SecurePass123!');
  if (!user || user.email !== 'secure@example.com') {
    throw new Error('Valid account creation failed');
  }

  let duplicateWasGeneric = false;
  try {
    await users.createUser('SECURE@example.com', 'AnotherPass123!');
  } catch (error) {
    duplicateWasGeneric = error.code === 'EMAIL_ALREADY_EXISTS'
      && !String(error.message).includes('已注册');
  }
  if (!duplicateWasGeneric) {
    throw new Error('Duplicate registration should use a generic account response');
  }

  if (await users.verifyCredentials('missing@example.com', 'WrongPassword123!')) {
    throw new Error('Missing account unexpectedly authenticated');
  }
  if (await users.verifyCredentials('secure@example.com', 'WrongPassword123!')) {
    throw new Error('Incorrect password unexpectedly authenticated');
  }
  if (!(await users.verifyCredentials('secure@example.com', 'SecurePass123!'))) {
    throw new Error('Valid account credentials failed');
  }

  console.log('Account security test passed.');
})()
  .then(async () => {
    await closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${testDbPath}${suffix}`, { force: true });
    }
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${testDbPath}${suffix}`, { force: true });
    }
    process.exit(1);
  });
