function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    req.session.flash = { type: 'error', message: '请先登录后台。' };
    return res.redirect('/admin/login');
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) {
    req.session.flash = { type: 'error', message: '请先登录账号。' };
    const nextPath = encodeURIComponent(req.originalUrl || '/my-orders');
    return res.redirect(`/login?next=${nextPath}`);
  }
  next();
}

module.exports = {
  requireAdmin,
  requireUser,
};
