const SENSITIVE_PATH_PREFIXES = [
  '/login',
  '/register',
  '/account',
  '/admin',
  '/orders',
  '/my-orders',
  '/delivery',
];

function isSensitivePath(pathname) {
  const value = String(pathname || '');
  return SENSITIVE_PATH_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'"
  );

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  if (isSensitivePath(req.path || req.originalUrl)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }

  next();
}

module.exports = {
  isSensitivePath,
  securityHeaders,
};
