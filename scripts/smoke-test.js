const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config();

const testDbPath = process.env.SMOKE_DATABASE_PATH
  || path.join(os.tmpdir(), `campus-vend-smoke-${process.pid}-${Date.now()}.db`);
const proofPath = path.join(os.tmpdir(), `campus-vend-proof-${process.pid}-${Date.now()}.png`);
const csrfUploadPath = path.join(os.tmpdir(), `campus-vend-csrf-${process.pid}-${Date.now()}.png`);

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = testDbPath;
process.env.SESSION_SECRET = 'smoke-test-session-secret-at-least-32-characters';
process.env.ADMIN_USERNAME = 'smoke-admin';
process.env.ADMIN_PASSWORD = 'SmokeAdminPass123!';

for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(`${testDbPath}${suffix}`, { force: true });
}
fs.writeFileSync(proofPath, Buffer.from('smoke proof fixture'));

const { getTrustProxy, validateRuntimeConfig } = require('../src/config');
const {
  MAX_ATTEMPTS,
  clearFailures,
  isLimited,
  registerFailure,
} = require('../src/middleware/admin-login-rate-limit');
const {
  csrfProtection,
  csrfProtectionAfterMultipart,
} = require('../src/middleware/csrf');
const { db, initDb, get, all, run } = require('../src/db');
const orders = require('../src/services/orders');
const users = require('../src/services/users');
const { findMatchedAmount, saveProof } = require('../src/services/ocr');
const { resolveProofPath, toStoredProofPath } = require('../src/upload');

function closeDb() {
  return new Promise((resolve) => db.close(() => resolve()));
}

function createMockResponse() {
  return {
    locals: {},
    statusCode: 200,
    body: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function testCsrfProtection() {
  const session = {};
  let nextCalled = false;
  const getResponse = createMockResponse();
  csrfProtection({ method: 'GET', session, headers: {}, body: {} }, getResponse, () => {
    nextCalled = true;
  });
  if (!nextCalled || !/^[a-f0-9]{64}$/i.test(session.csrfToken)) {
    throw new Error('GET request should receive a session CSRF token');
  }

  const rejectedResponse = createMockResponse();
  csrfProtection({ method: 'POST', session, headers: {}, body: {} }, rejectedResponse, () => {
    throw new Error('POST without CSRF token should not continue');
  });
  if (rejectedResponse.statusCode !== 403) {
    throw new Error('POST without CSRF token should be rejected');
  }

  let bodyTokenAccepted = false;
  csrfProtection({
    method: 'POST',
    session,
    headers: {},
    body: { _csrf: session.csrfToken },
  }, createMockResponse(), () => {
    bodyTokenAccepted = true;
  });
  if (!bodyTokenAccepted) {
    throw new Error('POST body CSRF token should be accepted');
  }

  let headerTokenAccepted = false;
  csrfProtection({
    method: 'POST',
    session,
    headers: { 'x-csrf-token': session.csrfToken },
    body: {},
  }, createMockResponse(), () => {
    headerTokenAccepted = true;
  });
  if (!headerTokenAccepted) {
    throw new Error('POST header CSRF token should be accepted');
  }

  const queryTokenResponse = createMockResponse();
  csrfProtection({
    method: 'POST',
    session,
    headers: {},
    body: {},
    query: { _csrf: session.csrfToken },
  }, queryTokenResponse, () => {
    throw new Error('Query-string CSRF token should not be accepted');
  });
  if (queryTokenResponse.statusCode !== 403) {
    throw new Error('Query-string CSRF token should be rejected');
  }

  const multipartRequest = {
    method: 'POST',
    session,
    headers: { 'content-type': 'multipart/form-data; boundary=smoke' },
    body: {},
  };
  let multipartParsingAllowed = false;
  csrfProtection(multipartRequest, createMockResponse(), () => {
    multipartParsingAllowed = true;
  });
  if (!multipartParsingAllowed || !multipartRequest.csrfMultipartPending) {
    throw new Error('Multipart request should be deferred until upload parsing finishes');
  }

  fs.writeFileSync(csrfUploadPath, Buffer.from('invalid csrf upload'));
  const invalidMultipartRequest = {
    ...multipartRequest,
    body: {},
    file: { path: csrfUploadPath },
  };
  const invalidMultipartResponse = createMockResponse();
  csrfProtectionAfterMultipart(invalidMultipartRequest, invalidMultipartResponse, () => {
    throw new Error('Multipart request without a body token should not continue');
  });
  if (invalidMultipartResponse.statusCode !== 403 || fs.existsSync(csrfUploadPath)) {
    throw new Error('Rejected multipart request should be blocked and its uploaded file removed');
  }

  let multipartTokenAccepted = false;
  csrfProtectionAfterMultipart({
    ...multipartRequest,
    body: { _csrf: session.csrfToken },
  }, createMockResponse(), () => {
    multipartTokenAccepted = true;
  });
  if (!multipartTokenAccepted) {
    throw new Error('Parsed multipart body CSRF token should be accepted');
  }
}

function testAdminLoginRateLimit() {
  const key = `smoke-${process.pid}-${Date.now()}`;
  clearFailures(key);
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    registerFailure(key);
  }
  if (!isLimited(key)) {
    throw new Error('Administrator login should be limited after repeated failures');
  }
  clearFailures(key);
  if (isLimited(key)) {
    throw new Error('Successful administrator login should clear failures');
  }
}

(async () => {
  let weakSecretRejected = false;
  try {
    validateRuntimeConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'change-me-before-selling',
    }, { warn: () => {} });
  } catch (error) {
    weakSecretRejected = /SESSION_SECRET/.test(error.message);
  }
  if (!weakSecretRejected) {
    throw new Error('Weak production session secret should be rejected');
  }

  validateRuntimeConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a-valid-production-session-secret-with-32-plus-characters',
  }, { warn: () => {} });

  if (getTrustProxy({}) !== false || getTrustProxy({ TRUST_PROXY: '1' }) !== 1) {
    throw new Error('Proxy trust should be disabled by default and enabled only explicitly');
  }

  testCsrfProtection();
  testAdminLoginRateLimit();

  await initDb();

  const admin = await get('SELECT username FROM admins LIMIT 1');
  const orderColumns = await all('PRAGMA table_info(orders)');
  const proofColumns = await all('PRAGMA table_info(payment_proofs)');
  const indexes = await all("SELECT name FROM sqlite_master WHERE type = 'index'");

  if (!admin || admin.username !== 'smoke-admin') {
    throw new Error('Configured initial administrator was not created');
  }
  if (await get("SELECT id FROM admins WHERE username = 'admin'")) {
    throw new Error('Insecure default administrator should not be created');
  }
  if (!orderColumns.some((column) => column.name === 'user_id')) {
    throw new Error('orders.user_id migration missing');
  }
  if (!proofColumns.some((column) => column.name === 'transaction_no')) {
    throw new Error('payment_proofs.transaction_no migration missing');
  }
  if (!indexes.some((index) => index.name === 'uq_orders_user_product_active')) {
    throw new Error('Active-order unique index missing');
  }
  if (!indexes.some((index) => index.name === 'idx_payment_proofs_transaction_no')) {
    throw new Error('Transaction-number review index missing');
  }
  if (indexes.some((index) => index.name === 'uq_payment_proofs_transaction_no')) {
    throw new Error('Transaction number should not remain uniquely constrained');
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

  const proofFile = { path: proofPath, filename: path.basename(proofPath) };
  const recognizedText = '支付金额 ￥9.90 交易单号 12345678901234567890';
  const proofA = await saveProof(orderA1, proofFile, {
    recognize: async () => recognizedText,
  });
  const reviewedOrderA = await orders.getOrderById(orderA1.id);
  const storedProofA = await get('SELECT * FROM payment_proofs WHERE id = ?', [proofA.proofId]);

  if (proofA.status !== 'pending' || reviewedOrderA.status !== 'review') {
    throw new Error('Matching OCR amount must enter manual review');
  }
  if (storedProofA.status !== 'pending') {
    throw new Error('Payment proof must remain pending before administrator confirmation');
  }
  if (reviewedOrderA.status === 'paid') {
    throw new Error('OCR amount match must never mark an order paid');
  }

  const proofB = await saveProof(orderB, proofFile, {
    recognize: async () => recognizedText,
  });
  const reviewedOrderB = await orders.getOrderById(orderB.id);
  const storedProofB = await get('SELECT * FROM payment_proofs WHERE id = ?', [proofB.proofId]);

  if (!proofB.reusedAcrossOrders || !storedProofB.reason.includes('曾用于其他订单')) {
    throw new Error('Cross-order screenshot reuse warning missing');
  }
  if (reviewedOrderB.status !== 'review') {
    throw new Error('Reused screenshot must remain in manual review');
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
    fs.rmSync(proofPath, { force: true });
    fs.rmSync(csrfUploadPath, { force: true });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    fs.rmSync(proofPath, { force: true });
    fs.rmSync(csrfUploadPath, { force: true });
    process.exit(1);
  });