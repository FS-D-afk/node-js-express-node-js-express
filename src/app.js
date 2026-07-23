const path = require('path');
const express = require('express');
const session = require('express-session');

const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin');
const storeRoutes = require('./routes/store');
const { getSessionSecret, getTrustProxy } = require('./config');
const { adminLoginRateLimit } = require('./middleware/admin-login-rate-limit');
const { adminLoginTimingProtection } = require('./middleware/admin-login-timing');
const { csrfProtection } = require('./middleware/csrf');
const { securityHeaders } = require('./middleware/security-headers');
const { getSettingMap } = require('./services/settings');
const users = require('./services/users');
const { randomToken } = require('./utils/tokens');

const app = express();
app.disable('x-powered-by');

const trustProxy = getTrustProxy(process.env);
if (trustProxy) {
  app.set('trust proxy', trustProxy);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(securityHeaders);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    name: 'campus_vend.sid',
    secret: getSessionSecret(process.env),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use(csrfProtection);
app.use('/admin/login', adminLoginRateLimit, adminLoginTimingProtection);

function readCookie(req, name) {
  const cookieHeader = String(req.headers.cookie || '');
  const prefix = `${name}=`;
  const part = cookieHeader
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));

  if (!part) return '';
  try {
    return decodeURIComponent(part.slice(prefix.length));
  } catch (error) {
    return '';
  }
}

app.use((req, res, next) => {
  const cookieName = 'campus_vend.customer';
  let customerToken = readCookie(req, cookieName);

  if (!/^[a-f0-9]{64}$/i.test(customerToken)) {
    customerToken = randomToken(32);
    res.cookie(cookieName, customerToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 3650,
      path: '/',
    });
  }

  req.customerToken = customerToken;
  res.locals.customerToken = customerToken;
  next();
});

app.use(async (req, res, next) => {
  try {
    const accountToken = readCookie(req, 'campus_vend.account');
    req.accountToken = accountToken;
    req.user = await users.getUserBySessionToken(accountToken);
    if (accountToken && !req.user) {
      res.clearCookie('campus_vend.account', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
    }
    res.locals.user = req.user;
    next();
  } catch (error) {
    next(error);
  }
});

app.use(async (req, res, next) => {
  try {
    res.locals.settings = await getSettingMap();
    res.locals.admin = req.session.admin || null;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    next();
  } catch (error) {
    next(error);
  }
});

app.use('/', accountRoutes);
app.use('/', storeRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: '页面不存在',
    message: '这个页面暂时找不到，可能链接已经失效。',
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render('error', {
    title: '系统开小差了',
    message: '请稍后重试，或联系管理员手动处理订单。',
  });
});

module.exports = app;
