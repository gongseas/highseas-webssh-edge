# Highseas UDP 连接监控

WebSSH 通过 SSH 自带的 `ss`、`/proc` 和 conntrack 读取网络连接。部分 VPS 内核不公开 UDP 对端，因此需要安装 Highseas Monitor 才能稳定显示 UDP 的对端 IP、端口、PID、进程名和上下行速率。

## 安装

在需要监控的 Debian 或 Ubuntu VPS 上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/gongseas/highseas-webssh-edge/main/public/agent/install.sh | sudo bash
```

支持 `x86_64/amd64` 和 `aarch64/arm64`。安装后重新连接 WebSSH，产生 UDP 流量后会自动显示，无需修改网页设置。

## 检查

```bash
sudo systemctl status highseas-monitor --no-pager
sudo highseas-monitor snapshot --json
```

如果 WebSSH 使用非 root SSH 用户，请把该用户加入只读监控组，然后重新登录：

```bash
sudo usermod -aG highseas-monitor SSH用户名
```

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/gongseas/highseas-webssh-edge/main/public/agent/install.sh | sudo bash -s -- --uninstall
```

Highseas Monitor 分析 UDP 数据包头部和 `/proc` 进程映射，在内存中保留已识别流最近 60 秒、未识别流最近 12 秒的计数；不保存数据包正文，不写数据库，不连接外部服务，也不开放网络端口。网页端会向 IP 归属地供应商查询对端公网 IP。

## 0.3.0 更新

- 收发采集使用 ETH_P_ALL，覆盖本机发出的 UDP 包；进程扫描独立运行，不再阻塞收包循环。
- 修正短窗口速率分母，避免将两秒数据除以三秒；常规速率仍按相邻采样累计字节差计算。
- 归属地查询不再阻塞 CPU、流量刷新，查询结果只更新当前采样，不回放旧流量。
- 网络面板增加 TCP/UDP 筛选、稳定 PID 排序、速率排序、上下分区拖动和最大化工具面板。
- 修复 Windows 校验文件换行、覆盖运行中二进制及升级后未重启服务的问题。

升级仍执行上面的安装命令。安装后网页网络栏应显示 `UDP v0.3.0`；显示“UDP 系统采样”表示当前 SSH 用户未能读取采集器。

速率是 B/s（每秒字节），不是 Mbps。UDP 按 IP 层报文字节计数，TCP 的系统计数口径不同，连接合计不应等同于网卡总量。短命套接字、IP 分片、高负载丢包及容器网络仍可能造成差异，不能据此承诺计费级精度。
