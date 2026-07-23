# 系统结构

## 请求层

- `src/routes/account.js`：用户注册、登录、退出和修改密码。
- `src/routes/store.js`：商品、订单、支付截图和发货页面。
- `src/routes/admin.js`：后台商品、订单、用户和设置管理。
- `src/middleware/auth.js`：用户及管理员访问控制。

## 服务层

- `src/services/catalog.js`：商品和分类。
- `src/services/orders.js`：订单创建、状态和过期处理。
- `src/services/ocr.js`：OCR 调用、金额提取和支付凭证保存。
- `src/services/users.js`：用户密码和长期登录会话。
- `src/services/settings.js`：站点配置。

## 数据层

`src/db.js` 负责：

- SQLite 连接。
- 建表和增量迁移。
- 默认设置初始化。
- 历史订单时间修正。
- 活跃订单唯一索引。

## 订单状态

```text
pending   待付款
review    OCR 未通过，等待人工审核
paid      已确认支付并可查看发货内容
expired   超过有效期
cancelled 管理员或系统取消
```

同一用户、同一商品最多存在一个 `pending` 或 `review` 订单。订单过期后，旧订单会先变为 `expired`，再允许创建新订单。

## 文件存储

```text
data/app.db                         SQLite 数据库
data/uploads/proofs/                付款截图
public/uploads/qr/                  收款码
public/uploads/product-details/     商品详情图片
```

付款截图不通过静态目录直接公开，只能由管理员鉴权路由读取。
