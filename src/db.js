const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const DEFAULT_ANNOUNCEMENT = '付款截图仅用于辅助审核，上传后统一进入待审核状态，最终由管理员确认付款后发货。';

const projectRoot = path.resolve(__dirname, '..');
const configuredDbPath = process.env.DATABASE_PATH || 'data/app.db';
const dbPath = path.isAbsolute(configuredDbPath)
  ? configuredDbPath
  : path.resolve(projectRoot, configuredDbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

async function ensureColumn(table, columnSql) {
  const columnName = columnSql.trim().split(/\s+/)[0];
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some((column) => column.name === columnName)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
  }
}

async function ensureHiddenSkuForProduct(product) {
  const skuName = '默认资料包';
  const existing = await get(
    'SELECT * FROM skus WHERE product_id = ? AND name = ? LIMIT 1',
    [product.id, skuName]
  );
  const deliveryText = product.delivery_text || '';
  const price = Number(product.price || 0).toFixed(2);

  if (existing) {
    await run(
      `UPDATE skus
       SET price = ?, delivery_url = ?, access_code = '', is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [price, deliveryText, product.is_active ? 1 : 0, existing.id]
    );
    return { ...existing, price, delivery_url: deliveryText, access_code: '' };
  }

  const result = await run(
    `INSERT INTO skus (product_id, name, price, delivery_url, access_code, is_active)
     VALUES (?, ?, ?, ?, '', ?)`,
    [product.id, skuName, price, deliveryText, product.is_active ? 1 : 0]
  );
  return get('SELECT * FROM skus WHERE id = ?', [result.id]);
}

async function deleteProductCascade(productId) {
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    await run(
      `DELETE FROM payment_proofs
       WHERE order_id IN (SELECT id FROM orders WHERE product_id = ?)`,
      [productId]
    );
    await run('DELETE FROM orders WHERE product_id = ?', [productId]);
    await run('DELETE FROM skus WHERE product_id = ?', [productId]);
    await run('DELETE FROM products WHERE id = ?', [productId]);
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

async function syncProductsFromLegacySkus() {
  const products = await all(`
    SELECT p.*,
      (
        SELECT s.price
        FROM skus s
        WHERE s.product_id = p.id AND s.is_active = 1
        ORDER BY s.id ASC
        LIMIT 1
      ) AS legacy_price,
      (
        SELECT CASE
          WHEN COALESCE(TRIM(s.access_code), '') <> '' THEN s.delivery_url || ' 提取码：' || s.access_code
          ELSE s.delivery_url
        END
        FROM skus s
        WHERE s.product_id = p.id AND s.is_active = 1
        ORDER BY s.id ASC
        LIMIT 1
      ) AS legacy_delivery_text
    FROM products p
  `);

  for (const product of products) {
    const nextPrice = Number(product.price || 0) > 0 ? Number(product.price) : Number(product.legacy_price || 0);
    const nextDeliveryText = product.delivery_text || product.legacy_delivery_text || '';
    const nextFileNote = product.file_note || product.preview_text || product.description || '';

    await run(
      `UPDATE products
       SET price = ?, delivery_text = ?, file_note = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextPrice, nextDeliveryText, nextFileNote, product.id]
    );

    await ensureHiddenSkuForProduct({
      ...product,
      price: nextPrice,
      delivery_text: nextDeliveryText,
      is_active: product.is_active,
    });
  }
}

function normalizeStoredProofPath(imagePath) {
  const normalized = String(imagePath || '').replace(/\\/g, '/');
  const fileName = path.posix.basename(normalized);
  if (!fileName || fileName === '.' || fileName === '..') return '';
  return path.posix.join('data', 'uploads', 'proofs', fileName);
}

async function normalizeStoredProofPaths() {
  const proofs = await all('SELECT id, image_path FROM payment_proofs');
  for (const proof of proofs) {
    const normalizedPath = normalizeStoredProofPath(proof.image_path);
    if (normalizedPath && normalizedPath !== proof.image_path) {
      await run('UPDATE payment_proofs SET image_path = ? WHERE id = ?', [normalizedPath, proof.id]);
    }
  }
}

async function ensureInitialAdmin() {
  const existingAdmin = await get('SELECT id FROM admins LIMIT 1');
  if (existingAdmin) return;

  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!username || password.length < 12) {
    throw new Error('首次启动需要在 .env 中配置 ADMIN_USERNAME 和至少 12 位的 ADMIN_PASSWORD。');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
}

async function initDb() {
  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA busy_timeout = 5000');
  try {
    await run('PRAGMA journal_mode = WAL');
  } catch (error) {
    await run('PRAGMA journal_mode = DELETE');
  }

  await run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    password_changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    preview_text TEXT NOT NULL DEFAULT '',
    file_note TEXT NOT NULL DEFAULT '',
    detail_image TEXT NOT NULL DEFAULT '',
    delivery_text TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    subject_id INTEGER,
    year_id INTEGER,
    material_type_id INTEGER,
    cover_image TEXT NOT NULL DEFAULT '',
    pay_amount_cursor INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(subject_id) REFERENCES categories(id) ON DELETE SET NULL,
    FOREIGN KEY(year_id) REFERENCES categories(id) ON DELETE SET NULL,
    FOREIGN KEY(material_type_id) REFERENCES categories(id) ON DELETE SET NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS skus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    delivery_url TEXT NOT NULL,
    access_code TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    product_id INTEGER NOT NULL,
    sku_id INTEGER NOT NULL,
    base_amount REAL NOT NULL,
    pay_amount REAL NOT NULL,
    customer_token TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    delivery_token TEXT NOT NULL,
    delivery_views INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    paid_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(sku_id) REFERENCES skus(id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS payment_proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    image_hash TEXT NOT NULL,
    ocr_text TEXT NOT NULL DEFAULT '',
    recognized_amount REAL,
    transaction_no TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);

  await ensureColumn('products', "file_note TEXT NOT NULL DEFAULT ''");
  await ensureColumn('products', "detail_image TEXT NOT NULL DEFAULT ''");
  await ensureColumn('products', "delivery_text TEXT NOT NULL DEFAULT ''");
  await ensureColumn('products', 'price REAL NOT NULL DEFAULT 0');
  await ensureColumn('products', 'pay_amount_cursor INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('orders', "customer_token TEXT NOT NULL DEFAULT ''");
  await ensureColumn('orders', 'user_id INTEGER');
  await ensureColumn('payment_proofs', "transaction_no TEXT NOT NULL DEFAULT ''");
  await normalizeStoredProofPaths();

  const duplicateActiveOrders = await all(`
    SELECT user_id, product_id, GROUP_CONCAT(id) AS ids
    FROM orders
    WHERE user_id IS NOT NULL AND status IN ('pending', 'review')
    GROUP BY user_id, product_id
    HAVING COUNT(*) > 1
  `);
  for (const group of duplicateActiveOrders) {
    const ids = String(group.ids || '')
      .split(',')
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    for (const id of ids.slice(1)) {
      await run("UPDATE orders SET status = 'cancelled' WHERE id = ?", [id]);
    }
  }

  await run('CREATE INDEX IF NOT EXISTS idx_orders_customer_token ON orders(customer_token)');
  await run('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at)');
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_user_product_active
    ON orders(user_id, product_id)
    WHERE user_id IS NOT NULL AND status IN ('pending', 'review')`);
  await run('DROP INDEX IF EXISTS uq_payment_proofs_transaction_no');
  await run('CREATE INDEX IF NOT EXISTS idx_payment_proofs_transaction_no ON payment_proofs(transaction_no)');

  await ensureInitialAdmin();
  await seedDefaults();
  await syncAnnouncementSetting();
  await syncProductsFromLegacySkus();
}

async function seedDefaults() {
  const count = await get('SELECT COUNT(*) AS total FROM settings');
  if (!count.total) {
    const defaults = {
      site_title: process.env.APP_NAME || '期末资料自动售卖',
      announcement: DEFAULT_ANNOUNCEMENT,
      contact: '请在售卖时间内联系管理员处理异常订单。',
      sales_enabled: '1',
      wechat_qr_path: '',
    };
    for (const [key, value] of Object.entries(defaults)) {
      await run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }

  const categoryCount = await get('SELECT COUNT(*) AS total FROM categories');
  if (!categoryCount.total) {
    const seeds = [
      ['高数', 'subject', 1],
      ['英语', 'subject', 2],
      ['2026', 'year', 1],
      ['2025', 'year', 2],
      ['期末真题', 'material_type', 1],
      ['复习资料', 'material_type', 2],
    ];
    for (const seed of seeds) {
      await run('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, ?)', seed);
    }
  }
}

async function syncAnnouncementSetting() {
  const row = await get("SELECT value FROM settings WHERE key = 'announcement'");
  if (!row || !row.value) return;

  const legacyHints = [
    '准确金额支付',
    '自动识别发货',
    '付款请按页面显示的准确金额支付',
    '支付金额和发货规则',
    '交易单号',
    '包含支付成功',
    '匹配即可自动发货',
    '只核对截图金额',
    '金额一致即可自动发货',
  ];
  if (legacyHints.some((hint) => row.value.includes(hint))) {
    await run("UPDATE settings SET value = ? WHERE key = 'announcement'", [DEFAULT_ANNOUNCEMENT]);
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
  ensureHiddenSkuForProduct,
  deleteProductCascade,
};
