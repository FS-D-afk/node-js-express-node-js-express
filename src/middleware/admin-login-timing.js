const bcrypt = require('bcryptjs');

const { get } = require('../db');

const DUMMY_ADMIN_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

async function adminLoginTimingProtection(req, res, next) {
  if (String(req.method || '').toUpperCase() !== 'POST') return next();

  try {
    const username = String(req.body?.username || '');
    const password = String(req.body?.password || '');
    const admin = await get('SELECT password_hash FROM admins WHERE username = ?', [username]);

    await bcrypt.compare(password || 'invalid-password', admin?.password_hash || DUMMY_ADMIN_PASSWORD_HASH);

    // The route performs one additional real comparison for existing accounts.
    // Perform a second dummy comparison for missing accounts so both paths do
    // approximately the same amount of password-hashing work.
    if (!admin) {
      await bcrypt.compare(password || 'invalid-password', DUMMY_ADMIN_PASSWORD_HASH);
    }

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  adminLoginTimingProtection,
};
