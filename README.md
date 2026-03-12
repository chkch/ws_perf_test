# WebSocket 性能压测工具

一个专为大规模、长时间 WebSocket 连接测试设计的 Node.js 压测工具。

**支持能力**：单机 5 万并发连接，7x24 小时稳定运行。

## 功能特性

- **大规模连接** - 单机支持 5 万+ 并发 WebSocket 连接
- **长时间稳定** - 针对 7x24 小时测试优化，防止内存泄漏
- **实时监控面板** - 连接状态、消息吞吐、延迟、内存使用一目了然
- **智能重连** - 指数退避重连机制，防止重连风暴
- **延迟统计** - P50/P95/P99 百分位延迟，基于 Ping/Pong RTT
- **优雅退出** - Ctrl+C 正常关闭所有连接，通知服务端
- **结果导出** - 支持 JSON/CSV 格式导出测试报告
- **WSS 支持** - 支持自定义 Headers、跳过证书验证

## 安装

```bash
git clone https://github.com/chkch/ws_perf_test.git
cd ws_perf_test
npm uninstall ws-perf-test -g && npm install && npm install . -g
chmod +x /usr/local/bin/ws-perf-test 
```

## 快速开始

```bash
# 基础测试
ws-perf-test ws://localhost:9502 -c 1000 -d 60

# 查看帮助
ws-perf-test --help
```

## 命令行参数

### 连接选项

| 参数 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--connections` | `-c` | 10000 | 总连接数 |
| `--batch` | `-b` | 500 | 每批建立的连接数 |
| `--interval` | `-i` | 1000 | 批次间隔（毫秒） |
| `--reconnect` | `-r` | false | 启用断线重连 |
| `--reconnectDelay` | - | 3000 | 重连基础延迟（毫秒） |
| `--maxReconnect` | - | 10 | 单连接最大重连次数 |
| `--rateLimit` | - | 0 | 每秒最大新建连接数，0=不限 |

### 消息选项

| 参数 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--msgInterval` | `-m` | 1000 | 消息发送间隔（毫秒） |
| `--pingInterval` | - | 30000 | Ping 心跳间隔（毫秒） |
| `--data` | - | null | 自定义消息 JSON 文件: {} 或 [{},{}] |

### 测试选项

| 参数 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--duration` | `-d` | 0 | 测试时长（秒），0=无限 |
| `--log` | `-l` | null | 日志输出文件 |
| `--verbose` | `-v` | false | 详细日志 |
| `--export` | - | null | 结果导出文件 |
| `--exportFormat` | - | json | 导出格式: json, csv |

### 稳定性选项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--killZombie` | false | 自动终止僵尸连接 |
| `--zombieTimeout` | 120000 | 僵尸判定超时（毫秒） |
| `--sharedTimers` | false | 共享定时器模式（大规模连接推荐） |
| `--gcInterval` | 60000 | 手动 GC 间隔（毫秒） |

### WSS/安全选项

| 参数 | 说明 |
|------|------|
| `--insecure` | 跳过 WSS 证书验证 |
| `--headers` | 自定义 HTTP Headers（JSON 格式） |
| `--subprotocol` | WebSocket 子协议 |

---

## 5 万连接 7x24 小时稳定性测试

### 前置条件

#### 1. 系统配置（客户端机器）

```bash
# 查看当前文件描述符限制
ulimit -n

# 临时增加限制（当前会话）
ulimit -n 65535

# 永久修改（需要 root）
# 编辑 /etc/security/limits.conf 添加：
# *         soft    nofile      65535
# *         hard    nofile      65535
```

#### 2. TCP 参数优化（Linux）

```bash
# 编辑 /etc/sysctl.conf 添加：
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# 应用配置
sudo sysctl -p
```

#### 3. macOS 配置

```bash
sudo launchctl limit maxfiles 65535 65535
```

### 推荐启动命令

```bash
# 5 万连接 7x24 小时稳定性测试
ulimit -n 50000

node --expose-gc --max-old-space-size=4096 src/ws_perf_test.js \
  ws://your-server:9502 \
  -c 50000 \
  -b 500 \
  -i 500 \
  -m 2000 \
  -r \
  --killZombie \
  --sharedTimers \
  -l stability_50k.log \
  --export result.json
```

**参数说明**：

| 参数 | 值 | 说明 |
|------|------|------|
| `--expose-gc` | - | 启用手动垃圾回收 |
| `--max-old-space-size` | 4096 | 4GB 堆内存（5万连接足够） |
| `-c` | 50000 | 5 万连接 |
| `-b` | 500 | 每批 500 个，约 100 秒建立完成 |
| `-i` | 500 | 批次间隔 500ms |
| `-m` | 2000 | 每 2 秒发送消息 |
| `-r` | - | 启用自动重连 |
| `--killZombie` | - | 自动清理僵尸连接 |
| `--sharedTimers` | - | 共享定时器，减少开销 |
| `-l` | stability_50k.log | 日志持久化 |
| `--export` | result.json | 导出测试结果 |

### 使用 tmux 后台运行（推荐）

```bash
# 创建 tmux 会话
tmux new -s ws_test

# 运行测试
ulimit -n 50000
node --expose-gc --max-old-space-size=4096 src/ws_perf_test.js \
  ws://your-server:9502 -c 50000 -b 500 -r --killZombie --sharedTimers \
  -l stability.log --export result.json

# 分离会话：Ctrl+B, D
# 重新连接：tmux attach -t ws_test
```

### 使用 PM2 运行

创建 `ecosystem.config.js`：

```javascript
module.exports = {
  apps: [{
    name: 'ws-perf-test',
    script: 'src/ws_perf_test.js',
    args: 'ws://your-server:9502 -c 50000 -b 500 -r --killZombie --sharedTimers -l /var/log/ws_test.log',
    node_args: '--expose-gc --max-old-space-size=4096',
    max_memory_restart: '3500M',
    log_file: '/var/log/ws_test_pm2.log',
    time: true
  }]
};
```

```bash
pm2 start ecosystem.config.js
pm2 logs ws-perf-test
pm2 monit
```

---

## 监控面板

```
═══════════════════════════════════════════════════════════════════════
                   WebSocket 长时间稳定性压测工具 v2.0
═══════════════════════════════════════════════════════════════════════

  目标地址: ws://192.168.1.100:9502
  运行时间: 1d 12h 35m

  ▌连接状态
    ● 活跃连接: 49,923 / 50,000 (99.8%)
    ✓ 成功: 50,156  ✗ 失败: 3  ⚠ 错误: 12
    ○ 关闭: 233  ↻ 重连: 230  ☠ 僵尸: 0
    ⏱ 平均连接时间: 45.32 ms

  ▌消息统计
    ↑ 发送: 1,823,456,789 (24,500/s)
    ↓ 接收: 1,823,456,102 (24,498/s)
    ⇅ 流量: ↑62.5 GB / ↓58.3 GB

  ▌延迟统计 (Ping RTT)
    ◔ 平均: 8.45 ms  ▼ 最小: 1 ms  ▲ 最大: 125 ms
    ◇ P50: 6.23 ms  P95: 18.45 ms  P99: 45.67 ms

  ▌系统资源
    ◈ 堆内存: 1.23 GB / 4.00 GB (30.8%)
    ◈ 峰值: 1.56 GB  RSS: 1.89 GB  外部: 89.45 MB

  Ctrl+C 结束 | 重连: 开 | 僵尸清理: 开 | 日志: stability.log
═══════════════════════════════════════════════════════════════════════
```

### 关键指标

| 指标 | 说明 | 健康范围 |
|------|------|----------|
| 活跃连接 | 当前 OPEN 状态连接数 | > 99% 目标数 |
| P99 延迟 | 99% 请求的最大延迟 | < 100ms |
| 堆内存 | V8 堆使用量 | < 80% 限制 |
| 重连次数 | 稳定后应趋于 0 | 越低越好 |

---

## 常见问题

### Q1: 报错 "EMFILE: too many open files"

```bash
ulimit -n 50000
```

### Q2: 连接数卡在某个值上不去

```bash
# Linux: 扩大端口范围
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
```

### Q3: 内存持续增长

```bash
# 启用手动 GC
node --expose-gc --max-old-space-size=4096 src/ws_perf_test.js ...
```

### Q4: 如何安全停止？

按 `Ctrl+C`，工具会：
1. 停止创建新连接
2. 批量关闭所有连接（发送 close frame 通知服务端）
3. 打印最终测试报告
4. 导出结果文件（如配置了 --export）

---

## 硬件配置建议

| 连接数 | 客户端 | 服务端 |
|--------|--------|--------|
| 1 万 | 2 核 2GB | 4 核 8GB |
| 5 万 | 4 核 4GB | 8 核 16GB |

---

## 测试报告示例

```
═══════════════════════════════════════════════════════════════════════
                            最终测试报告
═══════════════════════════════════════════════════════════════════════
  测试时长:       7d 0h 0m
  目标连接数:     50,000

  连接统计:
    成功连接:     52,345
    失败连接:     8
    错误次数:     456
    关闭次数:     2,353
    重连次数:     2,345
    僵尸清理:     12

  消息统计:
    发送消息:     1,512,000,000
    接收消息:     1,511,998,456
    发送流量:     62.5 GB
    接收流量:     58.3 GB

  延迟统计:
    平均延迟:     8.45 ms
    最小延迟:     1 ms
    最大延迟:     245 ms
    P50 延迟:     6.23 ms
    P95 延迟:     18.45 ms
    P99 延迟:     45.67 ms

  性能指标:
    平均发送速率: 2,500.00 msg/s
    平均接收速率: 2,499.97 msg/s

  内存使用:
    峰值内存:     1.56 GB
    最终内存:     1.23 GB
═══════════════════════════════════════════════════════════════════════
```

---

## 本地测试服务

提供一个简单的本地 WebSocket 服务用于测试：

```bash
node src/websocket-server.js
# 服务地址: ws://127.0.0.1:8080
```

---

## License

[MIT License](LICENSE)
