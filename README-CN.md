# Highseas WebSSH Edge

Highseas WebSSH Edge 是一个可部署到 Cloudflare Workers 的网页版 SSH/SFTP 管理工具。它参考 FinalShell 的常用工作流，提供真实 SSH 终端、服务器管理、文件编辑、进程监控、网络连接监控、快捷命令和管理端安全验证。

这是独立的 Cloudflare Edge 版本，不包含你的服务器列表、SSH 密钥、本地数据库、Cloudflare 密钥或部署私密信息。

在部分不公开 UDP 对端的 VPS 上，可安装 Highseas Monitor 来显示 UDP 对端 IP、端口、PID 和速率：

```bash
curl -fsSL https://raw.githubusercontent.com/gongseas/highseas-webssh-edge/main/public/agent/install.sh | sudo bash
```

详细说明见 [UDP 监控文档](docs/UDP-MONITOR-CN.md)。

详细说明请看 [README.md](README.md)。
