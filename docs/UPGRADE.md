# 现有服务器升级与回滚

## 升级前

进入服务器项目目录：

```bash
cd /var/www/campus-vend
```

记录当前版本并备份：

```bash
BACKUP_TIME=$(date +%Y%m%d-%H%M%S)

pm2 stop campus-vend

tar -czf "/root/campus-vend-backup-$BACKUP_TIME.tar.gz"   --exclude='node_modules'   -C /var/www campus-vend
```

## 使用 Git 更新

确认运行数据已经被 `.gitignore` 忽略：

```bash
git status
git pull --ff-only
npm ci --omit=dev
npm run check
pm2 restart campus-vend
pm2 status
```

## 使用 ZIP 更新

把新版本解压到临时目录后，只同步源码，不覆盖服务器真实数据：

```bash
rm -rf /tmp/campus-vend-release
mkdir -p /tmp/campus-vend-release

unzip campus-vend-release.zip -d /tmp/campus-vend-release

rsync -av --delete   --exclude='.env'   --exclude='data/'   --exclude='public/uploads/'   --exclude='node_modules/'   /tmp/campus-vend-release/campus-vend/   /var/www/campus-vend/

cd /var/www/campus-vend
npm ci --omit=dev
npm run check
pm2 restart campus-vend
```

## v1.2.2 首次启动

首次启动会执行幂等数据库迁移：

- 补充缺少的字段和索引。
- 清理同一用户、同一商品的重复有效订单。
- 识别旧版“订单有效期 + 8 小时”异常记录。
- 将异常订单时间修正为正常的北京时间 30 分钟有效期。
- 随后将已经到期的待付款订单标记为 `expired`。

迁移不会删除已支付订单和用户账号。升级前仍必须备份数据库。

## 验证

```bash
curl -fsS http://127.0.0.1:3000/healthz
pm2 logs campus-vend --lines 100 --nostream
```

页面回归：

1. 创建订单。
2. 等待订单超过有效期。
3. 在旧订单上传付款截图，应提示订单过期。
4. 点击“重新下单”，应创建新的待付款订单。
5. 管理后台应能看到旧订单为 `expired`。

## 回滚

```bash
pm2 stop campus-vend
mv /var/www/campus-vend /var/www/campus-vend.failed
tar -xzf /root/campus-vend-backup-时间戳.tar.gz -C /var/www
pm2 start campus-vend
```

回滚前确认备份文件名和目录结构。
