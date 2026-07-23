const crypto = require('crypto');

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function orderNo() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `OD${stamp}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

module.exports = {
  randomToken,
  orderNo,
};
