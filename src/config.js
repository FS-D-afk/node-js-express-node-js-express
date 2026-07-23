const INSECURE_SESSION_SECRETS = new Set([
  'dev-secret-change-me',
  'change-me-before-selling',
  'change-me',
  'replace-with-at-least-32-random-characters',
]);

const DEVELOPMENT_SESSION_SECRET = 'development-only-session-secret-do-not-deploy';

function normalizedSecret(env = process.env) {
  return String(env.SESSION_SECRET || '').trim();
}

function isInsecureSessionSecret(secret) {
  const normalized = String(secret || '').trim().toLowerCase();
  return normalized.length < 32 || INSECURE_SESSION_SECRETS.has(normalized);
}

function getSessionSecret(env = process.env) {
  const secret = normalizedSecret(env);
  if (env.NODE_ENV === 'production' && isInsecureSessionSecret(secret)) {
    throw new Error('生产环境必须配置至少 32 位且非默认值的 SESSION_SECRET。');
  }
  return secret || DEVELOPMENT_SESSION_SECRET;
}

function getTrustProxy(env = process.env) {
  return String(env.TRUST_PROXY || '').trim() === '1' ? 1 : false;
}

function validateRuntimeConfig(env = process.env, { warn = console.warn } = {}) {
  const sessionSecret = getSessionSecret(env);
  if (env.NODE_ENV !== 'production' && isInsecureSessionSecret(normalizedSecret(env))) {
    warn('警告：当前使用开发环境会话密钥，禁止用于正式部署。');
  }
  return {
    sessionSecret,
    trustProxy: getTrustProxy(env),
  };
}

module.exports = {
  DEVELOPMENT_SESSION_SECRET,
  getSessionSecret,
  getTrustProxy,
  isInsecureSessionSecret,
  validateRuntimeConfig,
};