const fs = require('fs');
const express = require('express');

const { requireUser } = require('../middleware/auth');
const catalog = require('../services/catalog');
const orders = require('../services/orders');
const users = require('../services/users');
const { saveProof } = require('../services/ocr');
const { proofUpload, isSupportedImageFile } = require('../upload');

const router = express.Router();

const STATUS_LABELS = {
  pending: '待付款',
  review: '待确认',
  paid: '已支付',
  expired: '已过期',
  cancelled: '已取消',
};

function orderUrl(order) {
  if (order.status === 'paid') {
    return `/delivery/${order.order_no}`;
  }
  return `/orders/${order.order_no}`;
}

function setScreenshotModal(req, message, title = '截图校验失败') {
  req.session.flash = {
    type: 'error',
    modal: true,
    title,
    message,
  };
}

function uploadErrorMessage(error) {
  if (!error) return '';
  if (error.code === 'LIMIT_FILE_SIZE') {
    return '截图文件过大，请上传不超过 5MB 的 PNG、JPG、WEBP 或 BMP 图片。';
  }
  return error.message || '截图格式不正确，请上传 PNG、JPG、WEBP 或 BMP 图片。';
}

function requestToken(req) {
  return String((req.body && req.body.token) || (req.query && req.query.token) || '');
}

function canAccess(req, order) {
  return orders.canAccessOrder(order, {
    userId: req.user ? req.user.id : null,
    token: requestToken(req),
  });
}

function redirectOrderUrl(req, order) {
  return `/orders/${order.order_no}`;
}

router.get('/', requireUser, async (req, res, next) => {
  try {
    await orders.expireOldOrders();
    const products = await catalog.listProducts();
    res.render('store/index', {
      title: res.locals.settings.site_title || '资料售卖',
      products,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/my-orders', requireUser, async (req, res, next) => {
  try {
    await orders.expireOldOrders();
    await users.claimBrowserOrders(
      req.user.id,
      req.customerToken,
      Object.values(req.session.activeOrders || {})
    );
    const customerOrders = await orders.listOrdersByUserId(req.user.id);
    res.render('store/my-orders', {
      title: '我的订单',
      orders: customerOrders,
      statusLabels: STATUS_LABELS,
      orderUrl,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/products/:id', requireUser, async (req, res, next) => {
  try {
    const product = await catalog.getProductById(req.params.id);
    if (!product) {
      return res.status(404).render('error', { title: '商品不存在', message: '该商品可能已下架。' });
    }
    res.render('store/product', { title: product.title, product });
  } catch (error) {
    next(error);
  }
});

router.post('/orders', requireUser, async (req, res, next) => {
  try {
    if (res.locals.settings.sales_enabled !== '1') {
      req.session.flash = { type: 'error', message: '当前暂未开放下单。' };
      return res.redirect('/');
    }

    const productId = String(req.body.product_id || '');

    const activeOrders = req.session.activeOrders || {};
    const cachedOrderNo = activeOrders[productId];

    if (cachedOrderNo) {
      const cachedOrder = await orders.getOrderByNo(cachedOrderNo);
      if (
        cachedOrder &&
        String(cachedOrder.product_id) === productId &&
        orders.userOwnsOrder(cachedOrder, req.user.id) &&
        !orders.isOrderExpired(cachedOrder) &&
        ['pending', 'review', 'paid'].includes(cachedOrder.status)
      ) {
        await orders.claimOrder(cachedOrder.id, req.customerToken, req.user.id);
        return res.redirect(orderUrl(cachedOrder));
      }
      delete activeOrders[productId];
      req.session.activeOrders = activeOrders;
    }

    const order = await orders.createOrder(productId, req.customerToken, req.user.id);
    req.session.activeOrders = {
      ...(req.session.activeOrders || {}),
      [productId]: order.order_no,
    };
    res.redirect(`/orders/${order.order_no}`);
  } catch (error) {
    req.session.flash = { type: 'error', message: error.message || '创建订单失败。' };
    res.redirect('back');
  }
});

router.get('/orders/:orderNo', requireUser, async (req, res, next) => {
  try {
    await orders.expireOldOrders();
    const order = await orders.getOrderByNo(req.params.orderNo);
    if (!order || !canAccess(req, order)) {
      return res.status(404).render('error', { title: '订单不存在', message: '订单链接无效，或该订单不属于当前账号。' });
    }

    await orders.claimOrder(order.id, req.customerToken, req.user ? req.user.id : null);
    const latestOrder = await orders.getOrderById(order.id);
    res.render('store/order', {
      title: `订单 ${latestOrder.order_no}`,
      order: latestOrder,
      statusLabel: STATUS_LABELS[latestOrder.status] || latestOrder.status,
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/orders/:orderNo/proofs',
  requireUser,
  (req, res, next) => {
    proofUpload.single('proof')(req, res, (error) => {
      req.proofUploadError = error || null;
      next();
    });
  },
  async (req, res, next) => {
    try {
      await orders.expireOldOrders();
      const order = await orders.getOrderByNo(req.params.orderNo);
      if (!order || !canAccess(req, order)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(404).render('error', { title: '订单不存在', message: '订单链接无效，或该订单不属于当前账号。' });
      }

      await orders.claimOrder(order.id, req.customerToken, req.user ? req.user.id : null);
      const redirectUrl = redirectOrderUrl(req, order);

      if (req.proofUploadError) {
        setScreenshotModal(req, uploadErrorMessage(req.proofUploadError));
        return res.redirect(redirectUrl);
      }
      if (!req.file) {
        setScreenshotModal(req, '请先选择一张付款成功截图，再点击上传。', '未选择截图');
        return res.redirect(redirectUrl);
      }
      if (!isSupportedImageFile(req.file.path)) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        setScreenshotModal(req, '文件内容不是有效的 PNG、JPG、WEBP 或 BMP 图片，请重新选择截图。');
        return res.redirect(redirectUrl);
      }
      if (order.status === 'expired' || orders.isOrderExpired(order)) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        req.session.flash = { type: 'error', message: '订单已超过有效时间，请重新下单。' };
        return res.redirect(redirectUrl);
      }
      if (!['pending', 'review'].includes(order.status)) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        req.session.flash = { type: 'info', message: '该订单当前不需要再次上传截图。' };
        return res.redirect(redirectUrl);
      }

      const result = await saveProof(order, req.file);
      if (result.status === 'accepted') {
        req.session.flash = { type: 'success', message: result.reason };
      } else {
        setScreenshotModal(req, result.reason);
      }
      res.redirect(redirectUrl);
    } catch (error) {
      next(error);
    }
  }
);

router.get('/orders/:orderNo/status', requireUser, async (req, res, next) => {
  try {
    await orders.expireOldOrders();
    const order = await orders.getOrderByNo(req.params.orderNo);
    if (!order || !canAccess(req, order)) {
      return res.status(404).json({ ok: false });
    }
    res.json({
      ok: true,
      status: STATUS_LABELS[order.status] || order.status,
      paid: order.status === 'paid',
      deliveryUrl: order.status === 'paid' ? `/delivery/${order.order_no}` : '',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/delivery/:orderNo', requireUser, async (req, res, next) => {
  try {
    const order = await orders.getOrderByNo(req.params.orderNo);
    if (!order || !canAccess(req, order)) {
      return res.status(404).render('error', { title: '发货链接无效', message: '请登录购买账号后，从“我的订单”重新进入。' });
    }

    await orders.claimOrder(order.id, req.customerToken, req.user ? req.user.id : null);
    if (!orders.canViewDelivery(order)) {
      return res.status(403).render('error', {
        title: '暂不可查看',
        message: '订单尚未支付或支付状态未确认。',
      });
    }
    await orders.recordDeliveryView(order.id);
    res.render('store/delivery', { title: '资料发货', order });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
