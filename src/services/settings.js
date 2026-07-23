const { get, all, run } = require('../db');

async function getSettingMap() {
  const rows = await all('SELECT key, value FROM settings');
  return rows.reduce((map, row) => {
    map[row.key] = row.value;
    return map;
  }, {});
}

async function getSetting(key, fallback = '') {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value || '')]
  );
}

module.exports = {
  getSettingMap,
  getSetting,
  setSetting,
};
