const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { all, get, run } = require('../db');
const { randomToken } = require('../utils/tokens');

const configuredLoginDays = Number(process.env.USER_LOGIN_DAYS || 30);
const LOGIN_DAYS = Number.isFinite(configuredLoginDays)
  ? Math.max(1, Math.floor(configuredLoginDays))
  : 30;
const MIN_PASSWORD_LENGTH = 12;
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
  };
}

function passwordLengthError(prefix = '密码') {
  return `${prefix}至少需要 ${MIN_PASSWORD_LENGTH} 位。`;
}

async function createUser(emailValue, password) {
  const email = normalizeEmail(emailValue);
  if (!isValidEmail(email)) {
    throw new Error('请输入有效的邮箱地址。');
  }
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(passwordLengthError());
  }

  const existing = await get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', [email]);
  if (existing) {
    const error = new Error('无法创建账号，请检查输入，或尝试登录。');
    error.code = 'EMAIL_ALREADY_EXISTS';
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await run(
    `INSERT INTO users (email, password_hash)
     VALUES (?, ?)`,
    [email, passwordHash]
  );
  return safeUser(await get('SELECT * FROM users WHERE id = ?', [result.id]));
}

async function verifyCredentials(emailValue, password) {
  const email = normalizeEmail(emailValue);
  const passwordValue = String(password || '');

  if (!email || !passwordValue) {
    await bcrypt.compare(passwordValue || 'invalid-password', DUMMY_PASSWORD_HASH);
    return null;
  }

  const user = await get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
  const candidateHash = user && user.status === 'active'
    ? user.password_hash
    : DUMMY_PASSWORD_HASH;
  const matches = await bcrypt.compare(passwordValue, candidateHash);

  if (!user || user.status !== 'active' || !matches) return null;
  return safeUser(user);
}

async function createLoginSession(userId) {
  const token = randomToken(32);
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + LOGIN_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  await run(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`,
    [userId, tokenHash, expiresAt]
  );

  return {
    token,
    maxAge: LOGIN_DAYS * 24 * 60 * 60 * 1000,
    expiresAt,
  };
}

async function getUserBySessionToken(token) {
  if (!/^[a-f0-9]{64}$/i.test(String(token || ''))) return null;
  const tokenHash = hashSessionToken(token);

  const user = await get(
    `SELECT u.*, s.last_used_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.expires_at > CURRENT_TIMESTAMP
       AND u.status = 'active'
     LIMIT 1`,
    [tokenHash]
  );

  if (!user) return null;

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  if (!user.last_used_at || user.last_used_at <= fiveMinutesAgo) {
    await run(
      `UPDATE user_sessions
       SET last_used_at = CURRENT_TIMESTAMP
       WHERE token_hash = ?`,
      [tokenHash]
    );
  }
  return safeUser(user);
}

async function deleteLoginSession(token) {
  if (!token) return;
  await run('DELETE FROM user_sessions WHERE token_hash = ?', [hashSessionToken(token)]);
}

async function deleteAllUserSessions(userId) {
  await run('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
}

async function removeExpiredSessions() {
  await run('DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
}

async function claimBrowserOrders(userId, customerToken, orderNumbers = []) {
  if (!userId) return;

  const uniqueOrderNumbers = [...new Set(orderNumbers.map(String).filter(Boolean))];
  const clauses = [];
  const params = [userId];

  if (customerToken) {
    clauses.push('customer_token = ?');
    params.push(customerToken);
  }
  if (uniqueOrderNumbers.length) {
    clauses.push(`order_no IN (${uniqueOrderNumbers.map(() => '?').join(', ')})`);
    params.push(...uniqueOrderNumbers);
  }
  if (!clauses.length) return;

  await run(
    `UPDATE orders
     SET user_id = ?
     WHERE user_id IS NULL
       AND (${clauses.join(' OR ')})`,
    params
  );
}

async function listUsers(search = '') {
  const keyword = String(search || '').trim();
  const params = [];
  let where = '';
  if (keyword) {
    where = 'WHERE u.email LIKE ?';
    params.push(`%${keyword}%`);
  }

  return all(
    `SELECT u.id, u.email, u.status, u.created_at, u.updated_at,
      COUNT(o.id) AS order_count,
      SUM(CASE WHEN o.status = 'paid' THEN o.pay_amount ELSE 0 END) AS paid_total,
      MAX(o.created_at) AS latest_order_at
     FROM users u
     LEFT JOIN orders o ON o.user_id = u.id
     ${where}
     GROUP BY u.id
     ORDER BY u.id DESC
     LIMIT 500`,
    params
  );
}

async function changePassword(userId, currentPassword, newPassword) {
  if (String(newPassword || '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(passwordLengthError('新密码'));
  }

  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || !(await bcrypt.compare(String(currentPassword || ''), user.password_hash))) {
    throw new Error('当前密码不正确。');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    await run(
      `UPDATE users
       SET password_hash = ?,
           password_changed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [passwordHash, userId]
    );
    await run('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }

  return safeUser(user);
}

async function resetPasswordByAdmin(userId, newPassword) {
  if (String(newPassword || '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(passwordLengthError('新密码'));
  }

  const user = await get('SELECT id, email FROM users WHERE id = ?', [userId]);
  if (!user) {
    throw new Error('用户不存在。');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    await run(
      `UPDATE users
       SET password_hash = ?,
           password_changed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [passwordHash, userId]
    );
    await run('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }

  return user;
}

module.exports = {
  LOGIN_DAYS,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  isValidEmail,
  createUser,
  verifyCredentials,
  createLoginSession,
  getUserBySessionToken,
  deleteLoginSession,
  deleteAllUserSessions,
  removeExpiredSessions,
  claimBrowserOrders,
  listUsers,
  changePassword,
  resetPasswordByAdmin,
};
