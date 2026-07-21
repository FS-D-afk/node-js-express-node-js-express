const express = require('express');

const users = require('../services/users');

const router = express.Router();

const loginAttempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function safeNext(value, fallback = '/') {
  const next = String(value || '');
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\r') || next.includes('\n')) {
    return fallback;
  }
  return next;
}

function accountCookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  };
}

function attemptKey(req, email) {
  return `${req.ip || 'unknown'}:${users.normalizeEmail(email)}`;
}

function isRateLimited(req, email) {
  const key = attemptKey(req, email);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.startedAt + WINDOW_MS <= now) {
    loginAttempts.set(key, { count: 0, startedAt: now });
    return false;
  }
  return current.count >= MAX_ATTEMPTS;
}

function registerFailure(req, email) {
  const key = attemptKey(req, email);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.startedAt + WINDOW_MS <= now) {
    loginAttempts.set(key, { count: 1, startedAt: now });
  } else {
    current.count += 1;
  }
}

function clearFailures(req, email) {
  loginAttempts.delete(attemptKey(req, email));
}

async function finishLogin(req, res, user, nextPath) {
  const activeOrderNumbers = Object.values(req.session.activeOrders || {});
  await users.claimBrowserOrders(user.id, req.customerToken, activeOrderNumbers);

  await new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });

  const login = await users.createLoginSession(user.id);
  res.cookie('campus_vend.account', login.token, accountCookieOptions(login.maxAge));
  req.session.flash = { type: 'success', message: `欢迎回来，${user.email}` };
  res.redirect(safeNext(nextPath));
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('store/login', {
    title: '用户登录',
    next: safeNext(req.query.next),
    email: String(req.query.email || ''),
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const email = users.normalizeEmail(req.body.email);
    const nextPath = safeNext(req.body.next);

    if (isRateLimited(req, email)) {
      req.session.flash = { type: 'error', message: '登录尝试次数过多，请 15 分钟后再试。' };
      return res.redirect(`/login?next=${encodeURIComponent(nextPath)}&email=${encodeURIComponent(email)}`);
    }

    const user = await users.verifyCredentials(email, req.body.password || '');
    if (!user) {
      registerFailure(req, email);
      req.session.flash = { type: 'error', message: '邮箱或密码错误。' };
      return res.redirect(`/login?next=${encodeURIComponent(nextPath)}&email=${encodeURIComponent(email)}`);
    }

    clearFailures(req, email);
    return finishLogin(req, res, user, nextPath);
  } catch (error) {
    next(error);
  }
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('store/register', {
    title: '注册账号',
    next: safeNext(req.query.next),
    email: String(req.query.email || ''),
  });
});

router.post('/register', async (req, res, next) => {
  try {
    const email = users.normalizeEmail(req.body.email);
    const nextPath = safeNext(req.body.next);

    if (req.body.password !== req.body.password_confirm) {
      req.session.flash = { type: 'error', message: '两次输入的密码不一致。' };
      return res.redirect(`/register?next=${encodeURIComponent(nextPath)}&email=${encodeURIComponent(email)}`);
    }

    const user = await users.createUser(email, req.body.password || '');
    return finishLogin(req, res, user, nextPath);
  } catch (error) {
    req.session.flash = { type: 'error', message: error.message || '注册失败，请稍后重试。' };
    const nextPath = safeNext(req.body.next);
    const email = users.normalizeEmail(req.body.email);
    res.redirect(`/register?next=${encodeURIComponent(nextPath)}&email=${encodeURIComponent(email)}`);
  }
});


router.get('/account/password', (req, res) => {
  if (!req.user) {
    req.session.flash = { type: 'error', message: '请先登录账号。' };
    return res.redirect('/login?next=%2Faccount%2Fpassword');
  }
  res.render('store/account-password', { title: '修改登录密码' });
});

router.post('/account/password', async (req, res, next) => {
  try {
    if (!req.user) {
      req.session.flash = { type: 'error', message: '请先登录账号。' };
      return res.redirect('/login?next=%2Faccount%2Fpassword');
    }

    const newPassword = String(req.body.new_password || '');
    if (newPassword !== String(req.body.password_confirm || '')) {
      req.session.flash = { type: 'error', message: '两次输入的新密码不一致。' };
      return res.redirect('/account/password');
    }

    await users.changePassword(req.user.id, req.body.current_password || '', newPassword);
    const login = await users.createLoginSession(req.user.id);
    res.cookie('campus_vend.account', login.token, accountCookieOptions(login.maxAge));
    req.session.flash = { type: 'success', message: '密码已更新，其他已登录设备已退出。' };
    res.redirect('/my-orders');
  } catch (error) {
    req.session.flash = { type: 'error', message: error.message || '修改密码失败。' };
    res.redirect('/account/password');
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await users.deleteLoginSession(req.accountToken);
    res.clearCookie('campus_vend.account', accountCookieOptions(0));
    req.session.flash = { type: 'success', message: '已退出登录。' };
    res.redirect('/login');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
