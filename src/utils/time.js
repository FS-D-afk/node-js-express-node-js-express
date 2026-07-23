const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const BEIJING_SQL_NOW = "datetime('now', '+8 hours')";

function getOrderExpireMinutes() {
  const configured = Number(process.env.ORDER_EXPIRE_MINUTES || 30);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 30;
}

function formatBeijingDateTime(value = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError('Invalid timestamp');
  }
  return new Date(timestamp + BEIJING_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function parseBeijingDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const isoText = text.replace(' ', 'T');
  const timestamp = Date.parse(hasTimezone ? isoText : `${isoText}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isBeijingDateTimeExpired(value, now = Date.now()) {
  const timestamp = parseBeijingDateTime(value);
  return timestamp === null || timestamp <= now;
}

module.exports = {
  BEIJING_OFFSET_MS,
  BEIJING_SQL_NOW,
  getOrderExpireMinutes,
  formatBeijingDateTime,
  parseBeijingDateTime,
  isBeijingDateTimeExpired,
};
