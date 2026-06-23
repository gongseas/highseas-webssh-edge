# Highseas WebSSH Edge

Highseas WebSSH Edge 是一个可部署到 Cloudflare Workers 的网页版 SSH/SFTP 管理工具。它参考 FinalShell 的常用工作流，提供真实 SSH 终端、服务器管理、文件编辑、进程监控、网络连接监控、快捷命令和管理端安全验证。

这是独立的 Cloudflare Edge 版本，不包含你的服务器列表、SSH 密钥、本地数据库、Cloudflare 密钥或部署私密信息。

[English README](README-EN.md)

## 功能

- 真实 SSH 终端：基于 Cloudflare Workers TCP sockets 和 `ssh2`。
- 服务器管理：支持分组、标签、密码登录、PEM/OpenSSH 私钥和 PuTTY PPK 私钥。
- SFTP 文件管理：支持目录浏览、上传、下载、文本文件双击编辑和保存。
- 系统监控：CPU、内存、Swap、磁盘、运行时间、负载和进程列表。
- 网络监控：显示监听 IP、端口、连接 IP、IP 归属地、连接数和上下行速率。
- 快捷命令：统一管理自定义命令，一键发送到当前 SSH 会话。
- 安全登录：管理员账号、密码哈希、Session Cookie、登录限速、TOTP 二次验证和恢复码。
- 加密存储：SSH 密码、私钥、私钥口令和 TOTP 密钥使用 AES-256-GCM 加密保存。
- 命令历史：可选开启，并过滤常见敏感命令。
- Cloudflare D1 数据库迁移和一键初始化部署脚本。

## 环境要求

- Node.js 20 或更高版本。
- Cloudflare 账号，并已启用 Workers 和 D1。
- 本机可使用 Wrangler 登录 Cloudflare。

## 一键部署到 Cloudflare

```bash
npm install
npx wrangler login
npm run setup:cloudflare
```

脚本会自动完成：

1. 如果 `wrangler.jsonc` 里还是 `REPLACE_WITH_D1_DATABASE_ID`，会创建名为 `highseas-edge` 的 D1 数据库。
2. 执行 D1 数据库迁移。
3. 生成 `highseas-master-key.txt`。
4. 写入 `MASTER_KEY` 和 `PASSWORD_PEPPER` 到 Worker Secret。
5. 构建并部署 Worker。

部署完成后，打开 Wrangler 输出的 `workers.dev` 地址。首次访问会要求创建管理员账号，管理员密码至少 12 位。

## 后续更新

```bash
npm install
npm run db:remote
npm run worker:deploy
```

## 本地开发

```bash
cp .dev.vars.example .dev.vars
# 把 MASTER_KEY 换成 base64 编码的 32 字节密钥
npm run db:local
npm run build
npm run worker:dev
```

可以用下面命令生成本地密钥：

```bash
openssl rand -base64 32
```

## 备份

备份 D1 数据库：

```bash
npx wrangler d1 export highseas-edge --remote --output highseas-edge-backup.sql
```

完整备份必须同时保存：

- `highseas-edge-backup.sql`
- 原始 `highseas-master-key.txt`

不要丢失 `highseas-master-key.txt`。如果它丢失，D1 中已经保存的 SSH 密码和私钥将无法解密恢复。

## 安全说明

- 没有默认用户名和默认密码。
- `.dev.vars`、`.wrangler/`、`dist/`、`node_modules/`、`highseas-master-key.txt` 已被 git 忽略。
- 不要提交真实 SSH 私钥、密码、恢复码、D1 备份、Worker Secret 或 API Token。
- Cloudflare 账号建议开启 2FA，并尽量收窄 API Token 权限。
- 如果公开部署，建议在 Worker 外层加 Cloudflare Access。
- Cloudflare Workers 只能连接公网 TCP 地址，不能 SSH 到 `localhost`、内网 IP 或 Cloudflare 自有 IP 段。

## 常用命令

```bash
npm run typecheck
npm test
npm run build
npm run worker:deploy
```

## 许可证

MIT
