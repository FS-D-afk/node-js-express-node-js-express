const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');

const { get, all, run } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const catalog = require('../services/catalog');
const orders = require('../services/orders');
const users = require('../services/users');
const { setSetting } = require('../services/settings');
const { qrUpload, productDetailUpload, resolveProofPath } = require('../upload');

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('admin/login', { title: '后台登录' });
});

router.post('/login', async (req, res, next) => {
  try {
    const admin = await get('SELECT * FROM admins WHERE username = ?', [req.body.username]);
    if (!admin || !(await bcrypt.compare(req.body.password || '', admin.password_hash))) {
      req.session.flash = { type: 'error', message: '账号或密码错误。' };
      return res.redirect('/admin/login');
    }
    req.session.regenerate((sessionError) => {
      if (sessionError) return next(sessionError);
      req.session.admin = { id: admin.id, username: admin.username };
      res.redirect('/admin');
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const [latestOrders, stats] = await Promise.all([
      orders.listOrders(''),
      get(`SELECT
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status = 'paid' THEN pay_amount ELSE 0 END) AS revenue,
        SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review_orders,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_orders,
        (SELECT COUNT(*) FROM users) AS total_users
       FROM orders`),
    ]);
    res.render('admin/dashboard', {
      title: '后台首页',
      orders: latestOrders.slice(0, 10),
      stats,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/products', requireAdmin, async (req, res, next) => {
  try {
    const products = await catalog.listProductsForAdmin();
    res.render('admin/products', { title: '商品管理', products });
  } catch (error) {
    next(error);
  }
});

router.get('/products/new', requireAdmin, async (req, res, next) => {
  try {
    res.render('admin/product-form', {
      title: '新增商品',
      product: {},
      action: '/admin/products/new',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/products/new', requireAdmin, productDetailUpload.single('detail_image_file'), async (req, res, next) => {
  try {
    const result = await catalog.upsertProduct({
      ...req.body,
      detail_image: req.file
        ? `/public/uploads/product-details/${req.file.filename}`
        : (req.body.detail_image_url || '').trim(),
      is_active: req.body.is_active === '1',
    });
    req.session.flash = { type: 'success', message: '商品已创建。' };
    res.redirect(`/admin/products/${result.id}/edit`);
  } catch (error) {
    next(error);
  }
});

router.get('/products/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const product = await catalog.getProductById(req.params.id, false);
    if (!product) return res.redirect('/admin/products');
    res.render('admin/product-form', {
      title: '编辑商品',
      product,
      action: `/admin/products/${product.id}/edit`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/products/:id/edit', requireAdmin, productDetailUpload.single('detail_image_file'), async (req, res, next) => {
  try {
    const existing = await catalog.getProductById(req.params.id, false);
    await catalog.upsertProduct({
      ...req.body,
      detail_image: req.file
        ? `/public/uploads/product-details/${req.file.filename}`
        : (req.body.detail_image_url || '').trim() || (existing ? existing.detail_image : ''),
      is_active: req.body.is_active === '1',
    }, req.params.id);
    req.session.flash = { type: 'success', message: '商品已更新。' };
    res.redirect('/admin/products');
  } catch (error) {
    next(error);
  }
});

router.post('/products/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await catalog.deleteProduct(req.params.id);
    req.session.flash = { type: 'success', message: '商品已删除。' };
    res.redirect('/admin/products');
  } catch (error) {
    next(error);
  }
});

router.get('/orders', requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status || '';
    res.render('admin/orders', {
      title: '订单管理',
      orders: await orders.listOrders(status),
      status,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:id/confirm', requireAdmin, async (req, res, next) => {
  try {
    await orders.markPaid(req.params.id);
    req.session.flash = { type: 'success', message: '订单已确认支付。' };
    res.redirect('/admin/orders');
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:id/cancel', requireAdmin, async (req, res, next) => {
  try {
    await orders.cancelOrder(req.params.id);
    req.session.flash = { type: 'success', message: '订单已取消。' };
    res.redirect('/admin/orders');
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:id/delivery', requireAdmin, async (req, res, next) => {
  try {
    const order = await orders.getOrderById(req.params.id);
    if (!order || order.status !== 'paid') {
      return res.status(404).render('error', {
        title: '发货信息不可用',
        message: '订单不存在或尚未确认支付。',
      });
    }
    res.render('store/delivery', { title: '后台查看发货信息', order });
  } catch (error) {
    next(error);
  }
});

router.get('/proofs/:id', requireAdmin, async (req, res, next) => {
  try {
    const proof = await get('SELECT * FROM payment_proofs WHERE id = ?', [req.params.id]);
    if (!proof) return res.status(404).send('not found');
    const proofPath = resolveProofPath(proof.image_path);
    if (!proofPath || !fs.existsSync(proofPath)) {
      return res.status(404).send('付款截图文件不存在');
    }
    res.sendFile(proofPath);
  } catch (error) {
    next(error);
  }
});


router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    res.render('admin/users', {
      title: '用户管理',
      users: await users.listUsers(search),
      search,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/reset-password', requireAdmin, async (req, res, next) => {
  try {
    const newPassword = String(req.body.new_password || '');
    if (newPassword !== String(req.body.password_confirm || '')) {
      req.session.flash = { type: 'error', message: '两次输入的新密码不一致。' };
      return res.redirect('/admin/users');
    }

    const user = await users.resetPasswordByAdmin(req.params.id, newPassword);
    req.session.flash = {
      type: 'success',
      message: `已重置 ${user.email} 的密码，并退出该账号的全部登录设备。`,
    };
    res.redirect('/admin/users');
  } catch (error) {
    req.session.flash = { type: 'error', message: error.message || '重置密码失败。' };
    res.redirect('/admin/users');
  }
});

router.get('/settings', requireAdmin, async (req, res) => {
  res.render('admin/settings', { title: '系统配置' });
});

router.get('/password', requireAdmin, (req, res) => {
  res.render('admin/password', { title: '修改密码' });
});

router.post('/password', requireAdmin, async (req, res, next) => {
  try {
    const admin = await get('SELECT * FROM admins WHERE id = ?', [req.session.admin.id]);
    if (!admin || !(await bcrypt.compare(req.body.current_password || '', admin.password_hash))) {
      req.session.flash = { type: 'error', message: '当前密码不正确。' };
      return res.redirect('/admin/password');
    }
    if (!req.body.new_password || req.body.new_password.length < 6) {
      req.session.flash = { type: 'error', message: '新密码至少 6 位。' };
      return res.redirect('/admin/password');
    }
    const passwordHash = await bcrypt.hash(req.body.new_password, 10);
    await run('UPDATE admins SET password_hash = ? WHERE id = ?', [passwordHash, admin.id]);
    req.session.flash = { type: 'success', message: '密码已修改。' };
    res.redirect('/admin');
  } catch (error) {
    next(error);
  }
});

router.post('/settings', requireAdmin, qrUpload.single('wechat_qr'), async (req, res, next) => {
  try {
    await setSetting('site_title', req.body.site_title);
    await setSetting('announcement', req.body.announcement);
    await setSetting('contact', req.body.contact);
    await setSetting('sales_enabled', req.body.sales_enabled === '1' ? '1' : '0');
    if (req.file) {
      await setSetting('wechat_qr_path', `/public/uploads/qr/${req.file.filename}`);
    }
    req.session.flash = { type: 'success', message: '配置已保存。' };
    res.redirect('/admin/settings');
  } catch (error) {
    next(error);
  }
});

router.get('/exports/orders.csv', requireAdmin, async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT o.*, u.email AS user_email, proof.transaction_no
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN payment_proofs proof ON proof.id = (
         SELECT pp.id FROM payment_proofs pp WHERE pp.order_id = o.id ORDER BY pp.id DESC LIMIT 1
       )
       ORDER BY o.id DESC`
    );
    const headers = ['order_no', 'user_email', 'base_amount', 'pay_amount', 'transaction_no', 'status', 'created_at', 'paid_at'];
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((key) => `"${String(row[key] || '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
