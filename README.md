# Campus Vend

基于 **Node.js、Express、EJS 与 SQLite** 的数字资料自动售卖系统。用户通过邮箱账号购买资料，上传支付截图后由 OCR 识别付款金额；金额匹配时自动确认订单并展示发货内容，异常订单可由管理员人工处理。

当前版本：**v1.2.2**

## v1.2.2 更新

- 修复订单超过有效期后，旧订单仍阻止创建新订单的问题。
- 订单创建、到期判断和历史异常订单迁移统一按北京时间处理。
- 自动修正旧版本中“30 分钟订单被记录为 510 分钟”的数据。
- 过期订单上传截图时明确提示重新下单。
- 过期或取消订单页面增加“重新下单”入口。
- 生产环境要求设置安全的 `SESSION_SECRET`。
- 首次初始化管理员支持使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。
- 增加 Ubuntu、PM2、Nginx 部署文档、升级文档与 GitHub Actions 检查。

完整变更请查看 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- 邮箱注册和密码登录，登录状态可长期保持。
- 订单绑定用户账号，支持跨设备查看“我的订单”。
- 同一用户购买同一商品时，只保留一个有效待处理订单。
- 待付款订单到期后自动标记为过期，并允许重新下单。
- 商品、分类、价格、发货信息和收款码后台管理。
- 支付截图上传及文件类型、文件内容和大小校验。
- OCR 识别截图金额，金额匹配后自动发货。
- OCR 失败或金额不匹配时进入人工审核。
- 管理员订单确认、取消、用户搜索和密码重置。
- SQLite 数据库自动建表和兼容迁移。
- Windows 与 Ubuntu/Linux 运行支持。

## 技术栈

- Node.js 18.18 或更高版本，推荐 Node.js 20 LTS
- Express 5
- EJS
- SQLite
- Multer
- Tesseract OCR（Linux 可选配置）
- PM2 与 Nginx（生产部署推荐）

## 快速开始

### 1. 安装依赖

```bash
npm ci
```

没有 `package-lock.json` 时可使用：

```bash
npm install
```

### 2. 创建配置

Linux/macOS：

```bash
cp .env.example .env
```

Windows CMD：

```bat
copy .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
SESSION_SECRET=请替换为至少32位随机字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请设置至少8位的首次管理员密码
```

生成随机会话密钥的示例：

```bash
openssl rand -hex 32
```

### 3. 启动

```bash
npm start
```

访问：

```text
前台：http://localhost:3000
后台：http://localhost:3000/admin
健康检查：http://localhost:3000/healthz
```

## 首次管理员账号

当数据库中还没有管理员时，系统读取：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的强密码
```

生产环境首次启动必须提供至少 8 位的 `ADMIN_PASSWORD`。已经存在管理员的数据库不会因为修改这两个环境变量而自动改名或重置密码，请在后台的“修改密码”页面操作。

开发环境未配置管理员密码时，系统为了兼容旧版本仍会创建测试账号 `admin / admin123`。该兼容行为不能用于公开服务器。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `NODE_ENV` | `development` | 生产环境设为 `production` |
| `APP_NAME` | `期末资料自动售卖` | 站点名称初始值 |
| `PORT` | `3000` | Node.js 监听端口 |
| `TZ` | `Asia/Shanghai` | Node.js 进程时区 |
| `SESSION_SECRET` | 无 | 生产环境至少 32 个字符 |
| `ADMIN_USERNAME` | `admin` | 仅在管理员表为空时使用 |
| `ADMIN_PASSWORD` | 开发兼容值 | 生产首次初始化必须至少 8 位 |
| `DATABASE_PATH` | `data/app.db` | SQLite 数据库路径 |
| `ORDER_EXPIRE_MINUTES` | `30` | 待付款订单有效期 |
| `USER_LOGIN_DAYS` | `30` | 用户长期登录天数 |
| `OCR_COMMAND` | 空 | Linux OCR 命令；Windows 留空使用 PowerShell OCR |

## OCR 配置

Windows 默认调用：

```text
scripts/windows-ocr.ps1
```

Ubuntu/Linux 可安装 Tesseract，并在 `.env` 设置：

```dotenv
OCR_COMMAND=tesseract {file} stdout -l chi_sim+eng
```

系统支持 PNG、JPG、WEBP 和 BMP，付款截图单张最大 5 MB。自动确认只验证截图中是否识别到与订单一致的金额；无法识别时会进入人工处理。

## 订单时间与过期逻辑

订单生命周期使用北京时间：

- 新订单明确写入北京时间的创建和到期时间。
- 数据库过期清理使用北京时间比较。
- 页面提交支付截图前再次执行过期清理。
- 状态轮询接口也会清理过期订单。
- 启动迁移只修正具有旧版“有效期 + 8 小时”特征的异常数据，迁移可重复执行。

登录会话过期时间在数据库内部继续使用 UTC，这是独立的安全会话逻辑，不影响订单页面显示和订单过期判断。

## 自动测试

```bash
npm test
```

完整语法检查和回归测试：

```bash
npm run check
```

测试使用临时 SQLite 数据库，不会修改正式的 `data/app.db`。

## Ubuntu 生产部署

详细步骤见：

- [Ubuntu、PM2 与 Nginx 部署](docs/DEPLOYMENT_UBUNTU.md)
- [现有服务器升级与回滚](docs/UPGRADE.md)

PM2 快速启动：

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

## 数据和备份

运行数据默认位于：

```text
data/app.db
data/uploads/proofs/
public/uploads/qr/
public/uploads/product-details/
```

升级前至少备份：

```bash
cp -a .env .env.backup
cp -a data data.backup
cp -a public/uploads public/uploads.backup
```

真实 `.env`、数据库、付款截图和用户上传文件不得提交到公开 GitHub 仓库。

## 目录结构

```text
.
├── server.js
├── ecosystem.config.cjs
├── src/
│   ├── routes/
│   ├── services/
│   ├── middleware/
│   └── utils/
├── views/
├── public/
├── data/                  # 运行时生成，不提交真实数据
├── scripts/
├── docs/
└── .github/workflows/
```

## 支付校验风险

本项目通过 OCR 金额匹配实现低成本自动确认，不是微信或支付宝官方支付回调。同价订单之间不能仅凭金额证明付款归属。涉及退款、争议或异常截图时，应结合后台订单和实际收款记录人工复核。

## 安全

请阅读 [SECURITY.md](SECURITY.md)。特别注意：

- 不要提交真实 `.env`、数据库、支付截图或私钥。
- 生产环境必须启用 HTTPS。
- 曾经公开过的会话密钥、Token 和密码应立即轮换。
- 首次登录后台后应检查并修改管理员密码。

## 许可证

本项目使用 [ISC License](LICENSE)。
