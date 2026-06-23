# Highseas WebSSH Edge

Highseas WebSSH Edge 是一个可部署到 Cloudflare Workers 的网页版 SSH/SFTP 管理工具，界面和工作流参考 FinalShell，支持真实 SSH 终端、服务器列表、文件编辑、进程/网络监控、快捷命令和管理端安全验证。

这个仓库是独立的 Cloudflare Edge 版本，不包含你的服务器列表、SSH 密钥、本地数据库或部署密钥。

## 功能

- 真实 SSH 终端，基于 Cloudflare Workers TCP sockets 和 `ssh2`。
- 支持密码、PEM/OpenSSH 私钥、PuTTY PPK 私钥导入。
- SFTP 文件浏览、上传、下载、文本文件编辑。
- CPU、内存、Swap、磁盘、进程和网络连接监控。
- 网络面板显示监听 IP、端口、连接 IP、归属地、连接数和上下行速率。
- 统一管理的自定义快捷命令。
- 管理员登录、密码哈希、Session Cookie、登录限速、TOTP 二次验证和恢复码。
- SSH 密码、私钥、私钥口令和 TOTP 密钥加密保存。
- 可选命令历史，并过滤常见敏感命令。
- D1 迁移和一键 Cloudflare 初始化脚本。

## 部署到 Cloudflare

```bash
npm install
npx wrangler login
npm run setup:cloudflare
```

脚本会自动：

1. 创建 `highseas-edge` D1 数据库。
2. 执行 D1 迁移。
3. 生成 `highseas-master-key.txt`。
4. 写入 `MASTER_KEY` 和 `PASSWORD_PEPPER` Worker Secret。
5. 构建并部署 Worker。

部署完成后打开 Wrangler 输出的 `workers.dev` 地址，首次访问会要求创建管理员账号。密码至少 12 位。

## 更新

```bash
npm install
npm run db:remote
npm run worker:deploy
```

## 备份

```bash
npx wrangler d1 export highseas-edge --remote --output highseas-edge-backup.sql
```

完整备份必须同时保存：

- `highseas-edge-backup.sql`
- 原始 `highseas-master-key.txt`

`highseas-master-key.txt` 丢失后，D1 里已保存的 SSH 密码和私钥无法恢复。

## 安全提醒

- 没有默认用户名和默认密码。
- `.dev.vars`、`.wrangler/`、`dist/`、`node_modules/`、`highseas-master-key.txt` 已被 git 忽略。
- 不要提交真实 SSH 密钥、密码、恢复码、D1 备份、Worker Secret 或 API Token。
- Cloudflare 账号建议开启 2FA，API Token 权限尽量收窄。
- 公开部署时，建议在外层加 Cloudflare Access。

## 许可证

MIT
