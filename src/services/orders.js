const { all, get, run } = require('../db');
const catalog = require('./catalog');
const { orderNo, randomToken } = require('../utils/tokens');
const {
  BEIJING_SQL_NOW,
  getOrderExpireMinutes,
  formatBeijingDateTime,
  isBeijingDateTimeExpired,
} = require('../utils/time');

function orderSelect() {
  return `SELECT o.*,
    u.email AS user_email,
    p.title AS product_title,
    p.description AS product_description,
    p.file_note AS file_note,
    p.delivery_text AS delivery_text,
    p.price AS product_price,
    hidden_sku.id AS hidden_sku_id,
    proof.id AS proof_id,
    proof.status AS proof_status,
    proof.reason AS proof_reason,
    proof.recognized_amount AS proof_amount,
    proof.transaction_no AS proof_transaction_no
   FROM orders o
   LEFT JOIN users u ON u.id = o.user_id
   JOIN products p ON p.id = o.product_id
   LEFT JOIN skus hidden_sku ON hidden_sku.id = o.sku_id
   LEFT JOIN payment_proofs proof ON proof.id = (
     SELECT pp.id FROM payment_proofs pp WHERE pp.order_id = o.id ORDER BY pp.id DESC LIMIT 1
   )`;
}

async function createOrder(productId, customerToken = '', userId = null) {
  if (!userId) {
    throw new Error('请先登录后再购买。');
  }

  const product = await get(
    `SELECT *
     FROM products
     WHERE id = ? AND is_active = 1`,
    [productId]
  );
  if (!product) {
    throw new Error('商品已下架。');
  }

  const hiddenSku = (await catalog.getDefaultSku(productId)) || (await catalog.upsertSku({
    product_id: productId,
    name: '默认资料包',
    price: product.price,
    delivery_url: product.delivery_text || '',
    access_code: '',
    is_active: true,
  }));

  const baseAmount = Number(product.price || 0).toFixed(2);
  const expireMinutes = getOrderExpireMinutes();
  const createdAt = formatBeijingDateTime();
  const expiresAt = formatBeijingDateTime(Date.now() + expireMinutes * 60 * 1000);
  const skuId = hiddenSku.id || hiddenSku;
  let orderId = null;

  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    await run(
      `UPDATE orders
       SET status = 'expired'
       WHERE user_id = ?
         AND product_id = ?
         AND status = 'pending'
         AND expires_at <= ${BEIJING_SQL_NOW}`,
      [userId, productId]
    );

    const existing = await get(
      `SELECT id
       FROM orders
       WHERE user_id = ?
         AND product_id = ?
         AND (
           status = 'paid'
           OR status = 'review'
           OR (status = 'pending' AND expires_at > ${BEIJING_SQL_NOW})
         )
       ORDER BY CASE status WHEN 'paid' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, id DESC
       LIMIT 1`,
      [userId, productId]
    );

    if (existing) {
      orderId = existing.id;
    } else {
      const result = await run(
        `INSERT INTO orders
         (order_no, product_id, sku_id, base_amount, pay_amount, customer_token, user_id, delivery_token, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNo(),
          productId,
          skuId,
          baseAmount,
          baseAmount,
          customerToken,
          userId,
          randomToken(18),
          expiresAt,
          createdAt,
        ]
      );
      orderId = result.id;
    }

    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');

    if (error && error.code === 'SQLITE_CONSTRAINT') {
      const existing = await get(
        `SELECT id
         FROM orders
         WHERE user_id = ?
           AND product_id = ?
           AND (
             status = 'review'
             OR (status = 'pending' AND expires_at > ${BEIJING_SQL_NOW})
           )
         ORDER BY id DESC LIMIT 1`,
        [userId, productId]
      );
      if (existing) return getOrderById(existing.id);
    }
    throw error;
  }

  return getOrderById(orderId);
}

function isOrderExpired(order) {
  return !order || isBeijingDateTimeExpired(order.expires_at);
}

async function getOrderById(id) {
  return get(`${orderSelect()} WHERE o.id = ?`, [id]);
}

async function getOrderByNo(orderNoValue) {
  return get(`${orderSelect()} WHERE o.order_no = ?`, [orderNoValue]);
}

async function listOrders(status = '') {
  const params = [];
  let where = '';
  if (status) {
    where = 'WHERE o.status = ?';
    params.push(status);
  }
  return all(`${orderSelect()} ${where} ORDER BY o.id DESC LIMIT 200`, params);
}

async function listOrdersByUserId(userId) {
  if (!userId) return [];
  return all(
    `${orderSelect()} WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 200`,
    [userId]
  );
}

async function listOrdersByCustomerToken(customerToken) {
  if (!customerToken) return [];
  return all(
    `${orderSelect()} WHERE o.customer_token = ? ORDER BY o.id DESC LIMIT 200`,
    [customerToken]
  );
}

function userOwnsOrder(order, userId) {
  return Boolean(order && userId && Number(order.user_id) === Number(userId));
}

function hasValidDeliveryToken(order, token) {
  return Boolean(order && token && order.delivery_token === token);
}

function canAccessOrder(order, { userId = null, token = '' } = {}) {
  if (!order) return false;
  if (order.user_id) return userOwnsOrder(order, userId);
  return hasValidDeliveryToken(order, token);
}

async function claimOrder(orderId, customerToken, userId = null) {
  if (!orderId) return;
  await run(
    `UPDATE orders
     SET customer_token = CASE
           WHEN COALESCE(customer_token, '') = '' THEN ?
           ELSE customer_token
         END,
         user_id = CASE
           WHEN user_id IS NULL AND ? IS NOT NULL THEN ?
           ELSE user_id
         END
     WHERE id = ?`,
    [customerToken || '', userId, userId, orderId]
  );
}

async function claimOrdersByNumber(customerToken, orderNumbers = [], userId = null) {
  const uniqueOrderNumbers = [...new Set(orderNumbers.map(String).filter(Boolean))];
  if (!uniqueOrderNumbers.length) return;

  const placeholders = uniqueOrderNumbers.map(() => '?').join(', ');
  await run(
    `UPDATE orders
     SET customer_token = CASE
           WHEN COALESCE(customer_token, '') = '' THEN ?
           ELSE customer_token
         END,
         user_id = CASE
           WHEN user_id IS NULL AND ? IS NOT NULL THEN ?
           ELSE user_id
         END
     WHERE order_no IN (${placeholders})`,
    [customerToken || '', userId, userId, ...uniqueOrderNumbers]
  );
}

async function markPaid(orderId, proofId = null) {
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    await run(
      `UPDATE orders
       SET status = 'paid', paid_at = ${BEIJING_SQL_NOW}, delivered_at = ${BEIJING_SQL_NOW}
       WHERE id = ? AND status IN ('pending', 'review')`,
      [orderId]
    );
    if (proofId) {
      await run(
        `UPDATE payment_proofs
         SET status = 'accepted', reason = '识别金额与订单金额一致，自动通过'
         WHERE id = ?`,
        [proofId]
      );
    }
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
  return getOrderById(orderId);
}

async function markReview(orderId) {
  await run(`UPDATE orders SET status = 'review' WHERE id = ? AND status = 'pending'`, [orderId]);
  return getOrderById(orderId);
}

async function cancelOrder(orderId) {
  await run(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'review')`, [orderId]);
}

async function recordDeliveryView(orderId) {
  await run('UPDATE orders SET delivery_views = delivery_views + 1 WHERE id = ?', [orderId]);
}

function canViewDelivery(order) {
  return Boolean(order && order.status === 'paid');
}

async function expireOldOrders() {
  await run(
    `UPDATE orders SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ${BEIJING_SQL_NOW}`
  );
}

module.exports = {
  createOrder,
  getOrderById,
  getOrderByNo,
  listOrders,
  listOrdersByUserId,
  listOrdersByCustomerToken,
  userOwnsOrder,
  hasValidDeliveryToken,
  canAccessOrder,
  claimOrder,
  claimOrdersByNumber,
  markPaid,
  markReview,
  cancelOrder,
  recordDeliveryView,
  canViewDelivery,
  isOrderExpired,
  expireOldOrders,
};
