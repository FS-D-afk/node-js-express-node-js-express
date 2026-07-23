# Contributing

1. 从 `main` 创建功能分支。
2. 不提交真实 `.env`、数据库、上传文件或日志。
3. 修改后执行：

```bash
npm ci
npm run check
```

4. 提交信息应说明修改范围和原因。
5. 涉及数据库迁移时，迁移必须可重复执行，并保留旧数据。
6. 涉及订单状态时，至少覆盖 `pending`、`review`、`paid`、`expired` 和 `cancelled`。
