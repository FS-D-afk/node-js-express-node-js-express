const crypto = require('crypto');
const fs = require('fs');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureToken(req) {
  if (!req.session) {
    throw new Error('CSRF protection requires session middleware.');
  }
  if (!TOKEN_PATTERN.test(String(req.session.csrfToken || ''))) {
    req.session.csrfToken = createToken();
  }
  return req.session.csrfToken;
}

function tokensEqual(expected, supplied) {
  const expectedBuffer = Buffer.from(String(expected || ''));
  const suppliedBuffer = Buffer.from(String(supplied || ''));
  return expectedBuffer.length === suppliedBuffer.length
    && expectedBuffer.length > 0
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function suppliedToken(req) {
  const headers = req.headers || {};
  return String(
    headers['x-csrf-token']
      || (req.body && req.body._csrf)
      || ''
  );
}

function isMultipart(req) {
  const headers = req.headers || {};
  return /^multipart\/form-data(?:;|$)/i.test(String(headers['content-type'] || ''));
}

function uploadedFiles(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files && typeof req.files === 'object') {
    for (const value of Object.values(req.files)) {
      if (Array.isArray(value)) files.push(...value);
      else if (value) files.push(value);
    }
  }
  return files;
}

function removeUploadedFiles(req) {
  for (const file of uploadedFiles(req)) {
    const filePath = String(file && file.path || '');
    if (!filePath) continue;
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      // The request is still rejected even when cleanup fails.
    }
  }
}

function rejectRequest(req, res) {
  removeUploadedFiles(req);
  return res.status(403).send('请求验证失败，请刷新页面后重试。');
}

function verifyRequestToken(req, res, next) {
  const expected = ensureToken(req);
  res.locals.csrfToken = expected;
  const supplied = suppliedToken(req);
  if (TOKEN_PATTERN.test(supplied) && tokensEqual(expected, supplied)) {
    req.csrfMultipartPending = false;
    return next();
  }
  return rejectRequest(req, res);
}

function csrfProtection(req, res, next) {
  const expected = ensureToken(req);
  res.locals.csrfToken = expected;

  if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) {
    return next();
  }

  if (isMultipart(req)) {
    req.csrfMultipartPending = true;
    return next();
  }

  return verifyRequestToken(req, res, next);
}

function csrfProtectionAfterMultipart(req, res, next) {
  return verifyRequestToken(req, res, next);
}

module.exports = {
  createToken,
  csrfProtection,
  csrfProtectionAfterMultipart,
  ensureToken,
  isMultipart,
  removeUploadedFiles,
  suppliedToken,
  tokensEqual,
};