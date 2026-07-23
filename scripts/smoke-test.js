const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.TZ = 'Asia/Shanghai';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'SmokeAdmin123!';

const testDbPath = process.env.SMOKE_DATABASE_PATH
  || path.join(os.tmpdir(), `campus-vend-smoke-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(`${testDbPath}${suffix}`, { force: true });
}

const { db, initDb, get, all, run } = require('../src/db');
const orders = require('../src/services/orders');
const users = require('../src/services/users');
const { findMatchedAmount } = require('../src/services/ocr');
const { resolveProofPath, toStoredProofPath } = require('../src/upload');

function closeDb() {
  return new Promise((resolve) => db.close(() => resolve()));
}

(async () => {
  await initDb();

  const admin = await get('SELECT id FROM admins WHERE username = ?', ['admin']);
  const orderColumns = await all('PRAGMA table_info(orders)');
  const proofColumns = await all('PRAGMA table_info(payment_proofs)');
  const indexes = await all("SELECT name FROM sqlite_master WHERE type = 'index'");

  if (!admin) throw new Error('Default admin missing');
  if (!orderColumns.some((column) => column.name === 'user_id')) {
    throw new Error('orders.user_id migration missing');
  }
  if (!proofColumns.some((column) => column.name === 'transaction_no')) {
    throw new Error('payment_proofs.transaction_no migration missing');
  }
  if (!indexes.some((index) => index.name === 'uq_orders_user_product_active')) {
    throw new Error('Active-order unique index missing');
  }
  if (!indexes.some((index) => index.name === 'uq_payment_proofs_transaction_no')) {
    throw new Error('Transaction-number unique index missing');
  }
  if (!orders.canViewDelivery({ status: 'paid', delivery_views: 999999 })) {
    throw new Error('Paid orders should have unlimited delivery access');
  }
  const legacyProofPath = 'C:\\old-project\\data\\uploads\\proofs\\example.png';
  if (!resolveProofPath(legacyProofPath).endsWith(path.join('data', 'uploads', 'proofs', 'example.png'))) {
    throw new Error('Legacy proof path resolution failed');
  }
  if (toStoredProofPath({ filename: 'example.png' }) !== 'data/uploads/proofs/example.png') {
    throw new Error('Portable proof path storage failed');
  }

  const product = await run(
    `INSERT INTO products (title, description, file_note, delivery_text, price, is_active)
     VALUES ('测试商品', '测试', '测试文件', 'https://example.com', 9.90, 1)`
  );
  await run(
    `INSERT INTO skus (product_id, name, price, delivery_url, is_active)
     VALUES (?, '默认资料包', 9.90, 'https://example.com', 1)`,
    [product.id]
  );

  const userA = await users.createUser('smoke-a@example.com', 'SmokePass123!');
  const userB = await users.createUser('smoke-b@example.com', 'SmokePass123!');

  const orderA1 = await orders.createOrder(product.id, 'customer-a', userA.id);
  const orderA2 = await orders.createOrder(product.id, 'customer-a', userA.id);
  const orderB = await orders.createOrder(product.id, 'customer-b', userB.id);

  if (orderA1.id !== orderA2.id) {
    throw new Error('Repeated purchase created duplicate active orders');
  }
  if (Number(orderA1.pay_amount).toFixed(2) !== '9.90') {
    throw new Error('Order amount is not equal to product price');
  }
  if (Number(orderB.pay_amount).toFixed(2) !== '9.90') {
    throw new Error('Different users should receive the same product price');
  }
  if (orderA1.id === orderB.id) {
    throw new Error('Different users should have separate orders');
  }
  if (!orders.canAccessOrder(orderA1, { userId: userA.id })) {
    throw new Error('Order owner cannot access order');
  }
  if (orders.canAccessOrder(orderA1, { userId: userB.id, token: orderA1.delivery_token })) {
    throw new Error('Bound order should not be accessible by another account');
  }

  const orderDurationMinutes = Math.round(
    (Date.parse(orderA1.expires_at.replace(' ', 'T') + '+08:00')
      - Date.parse(orderA1.created_at.replace(' ', 'T') + '+08:00')) / 60000
  );
  if (orderDurationMinutes !== Number(process.env.ORDER_EXPIRE_MINUTES || 30)) {
    throw new Error(`Order timestamps are not consistently stored in Beijing time: ${orderDurationMinutes}`);
  }

  await run(
    `UPDATE orders
     SET created_at = datetime('now', '+8 hours', '-31 minutes'),
         expires_at = datetime('now', '+8 hours', '-1 minute')
     WHERE id = ?`,
    [orderA1.id]
  );
  const staleOrder = await orders.getOrderById(orderA1.id);
  if (!orders.isOrderExpired(staleOrder)) {
    throw new Error('Stale Beijing-time order should be recognized as expired');
  }
  const replacementOrder = await orders.createOrder(product.id, 'customer-a', userA.id);
  if (replacementOrder.id === orderA1.id) {
    throw new Error('Expired order blocked creation of a replacement order');
  }
  const expiredOrder = await orders.getOrderById(orderA1.id);
  if (expiredOrder.status !== 'expired') {
    throw new Error('Stale pending order was not marked expired');
  }

  const amountOnlyText = '22:04 电量 10 星(**栋) ￥40.00 完成';
  if (findMatchedAmount(amountOnlyText, 40) !== '40.00') {
    throw new Error('Amount-only recognition failed');
  }
  if (findMatchedAmount(amountOnlyText, 10) !== null) {
    throw new Error('Status-bar integer should not be treated as payment amount');
  }
  if (findMatchedAmount('付款金额 ￥10', 10) !== '10.00') {
    throw new Error('Currency-context integer amount recognition failed');
  }

  const login = await users.createLoginSession(userA.id);
  if (!(await users.getUserBySessionToken(login.token))) {
    throw new Error('Persistent login session failed');
  }
  await users.resetPasswordByAdmin(userA.id, 'ResetPass123!');
  if (await users.getUserBySessionToken(login.token)) {
    throw new Error('Password reset should invalidate sessions');
  }

  console.log('Smoke test passed.');
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
    process.exit(1);
  });
