# Ubuntu 生产部署

本文以项目目录 `/var/www/campus-vend`、Node.js 端口 `3000` 和 PM2 进程名 `campus-vend` 为例。

## 1. 准备环境

推荐使用 Ubuntu LTS 和 Node.js 20 LTS。确认版本：

```bash
node -v
npm -v
```

安装运行工具和 OCR：

```bash
sudo apt update
sudo apt install -y nginx tesseract-ocr tesseract-ocr-chi-sim
sudo npm install -g pm2
```

## 2. 安装项目

```bash
sudo mkdir -p /var/www/campus-vend
sudo chown -R "$USER":"$USER" /var/www/campus-vend
cd /var/www/campus-vend

npm ci --omit=dev
cp .env.example .env
```

编辑 `.env`：

```dotenv
NODE_ENV=production
APP_NAME=期末资料自动售卖
PORT=3000
TZ=Asia/Shanghai

SESSION_SECRET=至少32位的随机字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=首次部署使用的强密码

DATABASE_PATH=data/app.db
ORDER_EXPIRE_MINUTES=30
USER_LOGIN_DAYS=30
OCR_COMMAND=tesseract {file} stdout -l chi_sim+eng
```

生成会话密钥：

```bash
openssl rand -hex 32
```

保护配置：

```bash
chmod 600 .env
```

## 3. 部署前检查

```bash
npm run check
```

测试使用临时数据库，不会写入正式数据库。

## 4. 使用 PM2 启动

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs campus-vend --lines 100
```

配置开机启动：

```bash
pm2 startup
```

按照 PM2 输出的命令再执行一次，然后：

```bash
pm2 save
```

## 5. 配置 Nginx

创建配置：

```bash
sudo nano /etc/nginx/sites-available/campus-vend
```

示例：

```nginx
server {
    listen 80;
    server_name example.com;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /healthz {
        proxy_pass http://127.0.0.1:3000/healthz;
        access_log off;
    }
}
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/campus-vend   /etc/nginx/sites-enabled/campus-vend

sudo nginx -t
sudo systemctl reload nginx
```

## 6. HTTPS

`NODE_ENV=production` 时登录 Cookie 会启用 `secure`，因此正式网站必须通过 HTTPS 访问。完成域名解析后，请使用可信证书配置 HTTPS。

若暂时只通过 HTTP 测试，请不要把 `NODE_ENV` 设置为 `production`；测试结束后应恢复生产配置并启用 HTTPS。

## 7. 健康检查

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

预期：

```json
{"ok":true}
```

## 8. 备份

建议定期备份：

```text
.env
data/app.db
data/uploads/
public/uploads/
```

SQLite 使用 WAL 模式时，在线复制单个 `app.db` 可能不是一致快照。更稳妥的方式是短暂停止应用后备份整个 `data` 目录：

```bash
pm2 stop campus-vend
tar -czf "/root/campus-vend-data-$(date +%Y%m%d-%H%M%S).tar.gz"   -C /var/www/campus-vend .env data public/uploads
pm2 start campus-vend
```

## 9. 常用命令

```bash
pm2 restart campus-vend
pm2 status
pm2 logs campus-vend --lines 100
npm run check
```
