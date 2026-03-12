#!/usr/bin/env node
const clc = require('cli-color');
const WebSocket = require('ws');
const fs = require('fs');
const v8 = require('v8');
const https = require('https');
const http = require('http');

// cli-color 兼容性处理                                                                                                                                                                                                                                                 
  if (!clc.gray) {                                          
      clc.gray = clc.blackBright || clc.white;
  }

// ========== 参数别名映射 ==========
const ARG_ALIASES = {
    c: 'connections',
    b: 'batch',
    i: 'interval',
    m: 'msgInterval',
    d: 'duration',
    v: 'verbose',
    h: 'help',
    r: 'reconnect',
    l: 'log',
};

// ========== 配置解析 ==========
const args = parseArgs(process.argv.slice(2));

if (args.help) {
    printHelp();
    process.exit(0);
}

const config = {
    url: args.url || 'ws://127.0.0.1:9502',
    totalConnections: parseInt(args.connections || 10000),
    batchSize: parseInt(args.batch || 500),
    batchIntervalMs: parseInt(args.interval || 1000),
    messageIntervalMs: parseInt(args.msgInterval || 1000),
    duration: parseInt(args.duration || 0),
    reconnect: args.reconnect || false,
    reconnectDelay: parseInt(args.reconnectDelay || 3000),
    maxReconnectAttempts: parseInt(args.maxReconnect || 10),
    pingInterval: parseInt(args.pingInterval || 30000),
    customDataFile: args.data || null,
    logFile: args.log || null,
    gcInterval: parseInt(args.gcInterval || 60000),
    // 新增配置
    rateLimit: parseInt(args.rateLimit || 0), // 每秒最大新建连接数，0=不限制
    headers: args.headers ? JSON.parse(args.headers) : {}, // 自定义 HTTP headers
    rejectUnauthorized: args.insecure ? false : true, // WSS 证书验证
    killZombie: args.killZombie || false, // 自动关闭僵尸连接
    zombieTimeout: parseInt(args.zombieTimeout || 120000), // 僵尸判定超时
    exportFile: args.export || null, // 结果导出文件
    exportFormat: args.exportFormat || 'json', // 导出格式: json, csv
    subprotocol: args.subprotocol || null, // WebSocket 子协议
    sharedTimers: args.sharedTimers || false, // 共享定时器模式（10万+连接推荐）
};

// 预序列化自定义消息（性能优化）
let customPayloads = null;
if (config.customDataFile) {
    try {
        const customJSON = JSON.parse(fs.readFileSync(config.customDataFile, 'utf8'));
        if (Array.isArray(customJSON)) {
            customPayloads = customJSON.map(item => JSON.stringify(item));
        } else {
            customPayloads = [JSON.stringify(customJSON)];
        }
    } catch (e) {
        console.error(clc.red(`无法解析 ${config.customDataFile}: ${e.message}，将使用默认模式`));
    }
}

// ========== 使用 BigInt 防止溢出 ==========
const stats = {
    connectSuccess: 0n,
    connectFailed: 0n,
    errorCount: 0n,
    closeCount: 0n,
    messagesSent: 0n,
    messagesReceived: 0n,
    bytesReceived: 0n,
    bytesSent: 0n,
    pongReceived: 0n,
    reconnectAttempts: 0n,
    zombieKilled: 0n,
    // 延迟统计 - 使用环形缓冲区
    latencyBuffer: new Float64Array(10000),
    latencyIndex: 0,
    latencyCount: 0,
    minLatency: Infinity,
    maxLatency: 0,
    latencySum: 0,
    // 连接时间统计
    connectTimeBuffer: new Float64Array(1000),
    connectTimeIndex: 0,
    connectTimeCount: 0,
    connectTimeSum: 0,
    // 速率统计
    lastMsgSent: 0n,
    lastMsgReceived: 0n,
    msgSentRate: 0n,
    msgReceivedRate: 0n,
    // 内存统计
    peakMemory: 0,
    // 错误分类（限制大小防止泄漏）
    errorTypes: new Map(),
    maxErrorTypes: 50,
};

// ========== 共享定时器（优化：避免20万个独立定时器）==========
let globalSendTimer = null;
let globalPingTimer = null;
const TIMER_BATCH_SIZE = 1000; // 每次处理的连接数

let activeConnections = 0;
let connectionsCreated = 0;
const connections = new Map();
const startTime = Date.now();
let logStream = null;
let lastLogTime = 0;

// 速率限制器
let rateLimitTokens = config.rateLimit || Infinity;
let lastRateLimitRefill = Date.now();

// 初始化日志
if (config.logFile) {
    logStream = fs.createWriteStream(config.logFile, { flags: 'a' });
    log(`[${new Date().toISOString()}] 测试启动 - 目标: ${config.url}, 连接数: ${config.totalConnections}`);
}

function log(message) {
    if (logStream) {
        logStream.write(message + '\n');
    }
}

// ========== 环形缓冲区延迟统计 ==========
function addLatency(latency) {
    if (stats.latencyCount >= stats.latencyBuffer.length) {
        stats.latencySum -= stats.latencyBuffer[stats.latencyIndex];
    } else {
        stats.latencyCount++;
    }
    stats.latencyBuffer[stats.latencyIndex] = latency;
    stats.latencySum += latency;
    stats.latencyIndex = (stats.latencyIndex + 1) % stats.latencyBuffer.length;
    if (latency < stats.minLatency) stats.minLatency = latency;
    if (latency > stats.maxLatency) stats.maxLatency = latency;
}

function addConnectTime(time) {
    if (stats.connectTimeCount >= stats.connectTimeBuffer.length) {
        stats.connectTimeSum -= stats.connectTimeBuffer[stats.connectTimeIndex];
    } else {
        stats.connectTimeCount++;
    }
    stats.connectTimeBuffer[stats.connectTimeIndex] = time;
    stats.connectTimeSum += time;
    stats.connectTimeIndex = (stats.connectTimeIndex + 1) % stats.connectTimeBuffer.length;
}

function getAvgLatency() {
    if (stats.latencyCount === 0) return 0;
    return stats.latencySum / stats.latencyCount;
}

function getAvgConnectTime() {
    if (stats.connectTimeCount === 0) return 0;
    return stats.connectTimeSum / stats.connectTimeCount;
}

// 计算百分位延迟
function getPercentileLatency(percentile) {
    if (stats.latencyCount === 0) return 0;
    const sorted = Array.from(stats.latencyBuffer.slice(0, stats.latencyCount)).sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
}

// ========== 连接管理 ==========
let connectionIdCounter = 0;

function createConnection(isReconnect = false, reconnectCount = 0) {
    // 速率限制检查
    if (config.rateLimit > 0) {
        const now = Date.now();
        const elapsed = now - lastRateLimitRefill;
        if (elapsed >= 1000) {
            rateLimitTokens = config.rateLimit;
            lastRateLimitRefill = now;
        }
        if (rateLimitTokens <= 0) {
            setTimeout(() => createConnection(isReconnect, reconnectCount), 100);
            return null;
        }
        rateLimitTokens--;
    }

    const connId = ++connectionIdCounter;
    const connectStartTime = Date.now();

    const wsOptions = {
        perMessageDeflate: false,
        skipUTF8Validation: true,
        handshakeTimeout: 10000,
        maxPayload: 100 * 1024 * 1024,
        headers: config.headers,
        rejectUnauthorized: config.rejectUnauthorized,
    };

    if (config.subprotocol) {
        wsOptions.protocol = config.subprotocol;
    }

    const ws = new WebSocket(config.url, wsOptions);

    const connMeta = {
        id: connId,
        ws,
        sendTimer: null,
        pingTimer: null,
        lastPingTime: 0,
        lastActivityTime: Date.now(),
        reconnectCount,
        createdAt: Date.now(),
    };

    connections.set(connId, connMeta);

    ws.on('open', () => {
        const connectTime = Date.now() - connectStartTime;
        addConnectTime(connectTime);
        stats.connectSuccess++;
        activeConnections++;
        connMeta.reconnectCount = 0;
        connMeta.lastActivityTime = Date.now();
        connMeta.lastSendTime = 0;
        connMeta.lastPingSendTime = 0;

        // 非共享定时器模式：每个连接独立定时器
        if (!config.sharedTimers) {
            connMeta.sendTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    sendMessage(ws, connMeta);
                }
            }, config.messageIntervalMs);
            connMeta.sendTimer.unref();

            connMeta.pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    connMeta.lastPingTime = Date.now();
                    try {
                        ws.ping();
                    } catch (e) {
                        // 忽略
                    }
                }
            }, config.pingInterval);
            connMeta.pingTimer.unref();
        }
    });

    ws.on('message', (data) => {
        stats.messagesReceived++;
        stats.bytesReceived += BigInt(Buffer.byteLength(data));
        connMeta.lastActivityTime = Date.now();
    });

    ws.on('pong', () => {
        stats.pongReceived++;
        connMeta.lastActivityTime = Date.now();
        if (connMeta.lastPingTime > 0) {
            const latency = Date.now() - connMeta.lastPingTime;
            addLatency(latency);
            connMeta.lastPingTime = 0;
        }
    });

    ws.on('error', (err) => {
        stats.errorCount++;
        // 错误分类统计（限制大小）
        const errType = err.code || err.message.split(' ')[0] || 'UNKNOWN';
        if (stats.errorTypes.size < stats.maxErrorTypes || stats.errorTypes.has(errType)) {
            stats.errorTypes.set(errType, (stats.errorTypes.get(errType) || 0) + 1);
        }
        if (args.verbose) {
            log(`[${new Date().toISOString()}] 连接 #${connId} 错误: ${err.code || ''} ${err.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        stats.closeCount++;
        activeConnections--;
        cleanupConnection(connMeta);
        connections.delete(connId);

        if (config.reconnect && !isShuttingDown && code !== 1000) {
            if (reconnectCount < config.maxReconnectAttempts) {
                stats.reconnectAttempts++;
                const delay = Math.min(config.reconnectDelay * Math.pow(1.5, reconnectCount), 30000);
                setTimeout(() => {
                    if (!isShuttingDown) {
                        createConnection(true, reconnectCount + 1);
                    }
                }, delay);
            } else if (args.verbose) {
                log(`[${new Date().toISOString()}] 连接 #${connId} 达到最大重连次数`);
            }
        }
    });

    ws.on('unexpected-response', (req, res) => {
        stats.connectFailed++;
        const errType = `HTTP_${res.statusCode}`;
        stats.errorTypes.set(errType, (stats.errorTypes.get(errType) || 0) + 1);
        if (args.verbose) {
            log(`[${new Date().toISOString()}] 连接 #${connId} 被拒绝: HTTP ${res.statusCode}`);
        }
    });

    return connMeta;
}

function sendMessage(ws, connMeta) {
    try {
        if (customPayloads) {
            for (const payload of customPayloads) {
                ws.send(payload);
                stats.messagesSent++;
                stats.bytesSent += BigInt(payload.length);
            }
        } else {
            // 优化：复用 buffer 减少 GC 压力
            const payload = `{"t":${Date.now()},"d":"${Math.random().toString(36).substring(2, 10)}"}`;
            ws.send(payload);
            stats.messagesSent++;
            stats.bytesSent += BigInt(payload.length);
        }
        connMeta.lastActivityTime = Date.now();
    } catch (e) {
        // 发送失败
    }
}

function cleanupConnection(connMeta) {
    if (connMeta.sendTimer) {
        clearInterval(connMeta.sendTimer);
        connMeta.sendTimer = null;
    }
    if (connMeta.pingTimer) {
        clearInterval(connMeta.pingTimer);
        connMeta.pingTimer = null;
    }
}

// ========== 批量连接 ==========
function connectBatch() {
    if (isShuttingDown) return;

    const remaining = config.totalConnections - connectionsCreated;
    if (remaining <= 0) return;

    const currentBatchSize = Math.min(config.batchSize, remaining);
    for (let i = 0; i < currentBatchSize; i++) {
        createConnection();
        connectionsCreated++;
    }

    if (connectionsCreated < config.totalConnections) {
        setTimeout(connectBatch, config.batchIntervalMs);
    }
}

// ========== 共享定时器模式（适用于10万+连接）==========
function startSharedTimers() {
    if (!config.sharedTimers) return;

    // 共享消息发送定时器 - 每次批量处理一部分连接
    let sendBatchIndex = 0;
    globalSendTimer = setInterval(() => {
        if (isShuttingDown) return;
        const now = Date.now();
        const connArray = [...connections.values()];
        const batchEnd = Math.min(sendBatchIndex + TIMER_BATCH_SIZE, connArray.length);

        for (let i = sendBatchIndex; i < batchEnd; i++) {
            const connMeta = connArray[i];
            if (connMeta && connMeta.ws.readyState === WebSocket.OPEN) {
                if (now - (connMeta.lastSendTime || 0) >= config.messageIntervalMs) {
                    sendMessage(connMeta.ws, connMeta);
                    connMeta.lastSendTime = now;
                }
            }
        }

        sendBatchIndex = batchEnd >= connArray.length ? 0 : batchEnd;
    }, Math.max(10, Math.floor(config.messageIntervalMs / Math.ceil(config.totalConnections / TIMER_BATCH_SIZE))));
    globalSendTimer.unref();

    // 共享 Ping 定时器
    let pingBatchIndex = 0;
    globalPingTimer = setInterval(() => {
        if (isShuttingDown) return;
        const now = Date.now();
        const connArray = [...connections.values()];
        const batchEnd = Math.min(pingBatchIndex + TIMER_BATCH_SIZE, connArray.length);

        for (let i = pingBatchIndex; i < batchEnd; i++) {
            const connMeta = connArray[i];
            if (connMeta && connMeta.ws.readyState === WebSocket.OPEN) {
                if (now - (connMeta.lastPingSendTime || 0) >= config.pingInterval) {
                    connMeta.lastPingTime = now;
                    connMeta.lastPingSendTime = now;
                    try {
                        connMeta.ws.ping();
                    } catch (e) {}
                }
            }
        }

        pingBatchIndex = batchEnd >= connArray.length ? 0 : batchEnd;
    }, Math.max(100, Math.floor(config.pingInterval / Math.ceil(config.totalConnections / TIMER_BATCH_SIZE))));
    globalPingTimer.unref();

    log(`[${new Date().toISOString()}] 共享定时器模式已启动`);
}

function stopSharedTimers() {
    if (globalSendTimer) {
        clearInterval(globalSendTimer);
        globalSendTimer = null;
    }
    if (globalPingTimer) {
        clearInterval(globalPingTimer);
        globalPingTimer = null;
    }
}

// ========== 内存监控 ==========
function getMemoryUsage() {
    const usage = process.memoryUsage();
    if (usage.heapUsed > stats.peakMemory) {
        stats.peakMemory = usage.heapUsed;
    }
    return usage;
}

function formatBytes(bytes) {
    const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(2) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatNumber(n) {
    return Number(n).toLocaleString();
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// ========== 状态显示 ==========
function printStats() {
    const elapsed = Date.now() - startTime;
    const mem = getMemoryUsage();

    stats.msgSentRate = stats.messagesSent - stats.lastMsgSent;
    stats.msgReceivedRate = stats.messagesReceived - stats.lastMsgReceived;
    stats.lastMsgSent = stats.messagesSent;
    stats.lastMsgReceived = stats.messagesReceived;

    const heapStats = v8.getHeapStatistics();
    const p50 = getPercentileLatency(50);
    const p95 = getPercentileLatency(95);
    const p99 = getPercentileLatency(99);

    console.clear();
    console.log(clc.bold.cyan('═══════════════════════════════════════════════════════════════════════'));
    console.log(clc.bold.white('                   WebSocket 长时间稳定性压测工具 v2.0'));
    console.log(clc.bold.cyan('═══════════════════════════════════════════════════════════════════════'));
    console.log();
    console.log(clc.white(`  目标地址: ${clc.yellow(config.url)}`));
    console.log(clc.white(`  运行时间: ${clc.yellow(formatDuration(elapsed))}`) +
        (config.duration > 0 ? clc.gray(` / ${formatDuration(config.duration * 1000)}`) : ''));
    console.log();

    console.log(clc.bold.green('  ▌连接状态'));
    const connProgress = Math.min(100, (activeConnections / config.totalConnections) * 100).toFixed(1);
    console.log(`    ${clc.green('●')} 活跃连接: ${clc.bold.white(activeConnections.toLocaleString())} / ${config.totalConnections.toLocaleString()} (${connProgress}%)`);
    console.log(`    ${clc.green('✓')} 成功: ${clc.white(formatNumber(stats.connectSuccess))}  ${clc.red('✗')} 失败: ${clc.white(formatNumber(stats.connectFailed))}  ${clc.yellow('⚠')} 错误: ${clc.white(formatNumber(stats.errorCount))}`);
    console.log(`    ${clc.gray('○')} 关闭: ${clc.white(formatNumber(stats.closeCount))}  ${clc.cyan('↻')} 重连: ${clc.white(formatNumber(stats.reconnectAttempts))}  ${clc.red('☠')} 僵尸: ${clc.white(formatNumber(stats.zombieKilled))}`);
    console.log(`    ${clc.gray('⏱')} 平均连接时间: ${clc.white(getAvgConnectTime().toFixed(2))} ms`);
    console.log();

    console.log(clc.bold.blue('  ▌消息统计'));
    console.log(`    ${clc.cyan('↑')} 发送: ${clc.white(formatNumber(stats.messagesSent))} (${clc.green(formatNumber(stats.msgSentRate) + '/s')})`);
    console.log(`    ${clc.cyan('↓')} 接收: ${clc.white(formatNumber(stats.messagesReceived))} (${clc.green(formatNumber(stats.msgReceivedRate) + '/s')})`);
    console.log(`    ${clc.cyan('⇅')} 流量: ↑${clc.white(formatBytes(stats.bytesSent))} / ↓${clc.white(formatBytes(stats.bytesReceived))}`);
    console.log();

    console.log(clc.bold.magenta('  ▌延迟统计 (Ping RTT)'));
    console.log(`    ${clc.magenta('◔')} 平均: ${clc.white(getAvgLatency().toFixed(2))} ms  ` +
        `${clc.magenta('▼')} 最小: ${clc.white(stats.minLatency === Infinity ? '-' : stats.minLatency)} ms  ` +
        `${clc.magenta('▲')} 最大: ${clc.white(stats.maxLatency === 0 ? '-' : stats.maxLatency)} ms`);
    console.log(`    ${clc.magenta('◇')} P50: ${clc.white(p50.toFixed(2))} ms  ` +
        `P95: ${clc.white(p95.toFixed(2))} ms  ` +
        `P99: ${clc.white(p99.toFixed(2))} ms`);
    console.log();

    console.log(clc.bold.yellow('  ▌系统资源'));
    const heapPercent = ((mem.heapUsed / heapStats.heap_size_limit) * 100).toFixed(1);
    console.log(`    ${clc.yellow('◈')} 堆内存: ${clc.white(formatBytes(mem.heapUsed))} / ${formatBytes(heapStats.heap_size_limit)} (${heapPercent}%)`);
    console.log(`    ${clc.yellow('◈')} 峰值: ${clc.white(formatBytes(stats.peakMemory))}  RSS: ${clc.white(formatBytes(mem.rss))}  外部: ${clc.white(formatBytes(mem.external))}`);

    // 显示 Top 3 错误类型
    if (stats.errorTypes.size > 0) {
        console.log();
        console.log(clc.bold.red('  ▌错误类型 (Top 3)'));
        const sortedErrors = [...stats.errorTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        sortedErrors.forEach(([type, count]) => {
            console.log(`    ${clc.red('•')} ${type}: ${clc.white(count)}`);
        });
    }

    console.log();
    console.log(clc.gray(`  Ctrl+C 结束 | 重连: ${config.reconnect ? '开' : '关'} | 僵尸清理: ${config.killZombie ? '开' : '关'} | 日志: ${config.logFile || '关'}`));
    console.log(clc.bold.cyan('═══════════════════════════════════════════════════════════════════════'));

    // 定期写入日志（每分钟一次）
    const now = Date.now();
    if (logStream && now - lastLogTime >= 60000) {
        lastLogTime = now;
        log(`[${new Date().toISOString()}] 活跃=${activeConnections}, 发送=${stats.messagesSent}, 接收=${stats.messagesReceived}, ` +
            `延迟avg=${getAvgLatency().toFixed(2)}ms/p99=${p99.toFixed(2)}ms, 内存=${formatBytes(mem.heapUsed)}`);
    }
}

const statsInterval = setInterval(printStats, 1000);

// ========== 定期 GC ==========
let gcInterval = null;
if (global.gc) {
    gcInterval = setInterval(() => {
        global.gc();
        log(`[${new Date().toISOString()}] 手动 GC 完成`);
    }, config.gcInterval);
    gcInterval.unref();
}

// ========== 健康检查 ==========
const healthCheckInterval = setInterval(() => {
    const now = Date.now();
    let staleCount = 0;

    for (const [id, connMeta] of connections) {
        if (connMeta.ws.readyState === WebSocket.OPEN) {
            if (now - connMeta.lastActivityTime > config.zombieTimeout) {
                staleCount++;
                if (config.killZombie) {
                    connMeta.ws.terminate();
                    stats.zombieKilled++;
                    if (args.verbose) {
                        log(`[${new Date().toISOString()}] 终止僵尸连接 #${id}`);
                    }
                }
            }
        }
    }

    if (staleCount > 0 && args.verbose && !config.killZombie) {
        log(`[${new Date().toISOString()}] 发现 ${staleCount} 个僵尸连接 (未处理)`);
    }
}, 60000);
healthCheckInterval.unref();

// ========== 参数解析 ==========
function parseArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) {
                result[key] = next;
                i++;
            } else {
                result[key] = true;
            }
        } else if (arg.startsWith('-') && arg.length === 2) {
            const shortKey = arg.slice(1);
            const fullKey = ARG_ALIASES[shortKey] || shortKey; // 使用别名映射
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) {
                result[fullKey] = next;
                i++;
            } else {
                result[fullKey] = true;
            }
        } else if (!result.url) {
            result.url = arg;
        }
    }
    return result;
}

function printHelp() {
    console.log(`
${clc.bold.cyan('WebSocket 长时间稳定性压测工具 v2.0')}

${clc.bold('用法:')}
  node --max-old-space-size=8192 ws_perf_test.js [url] [选项]

${clc.bold('连接选项:')}
  -c, --connections <num>      总连接数 (默认: 10000)
  -b, --batch <num>            每批连接数 (默认: 500)
  -i, --interval <ms>          批次间隔毫秒 (默认: 1000)
  -r, --reconnect              启用断线重连
  --reconnectDelay <ms>        重连延迟毫秒 (默认: 3000)
  --maxReconnect <num>         最大重连次数 (默认: 10)
  --rateLimit <num>            每秒最大新建连接数，0=不限 (默认: 0)

${clc.bold('消息选项:')}
  -m, --msgInterval <ms>       消息发送间隔 (默认: 1000)
  --pingInterval <ms>          Ping 间隔 (默认: 30000)
  --data <file>                自定义消息 JSON 文件

${clc.bold('WSS/安全选项:')}
  --insecure                   跳过 WSS 证书验证
  --headers <json>             自定义 HTTP Headers (JSON 格式)
  --subprotocol <name>         WebSocket 子协议

${clc.bold('测试选项:')}
  -d, --duration <seconds>     测试持续时间，0=无限 (默认: 0)
  -l, --log <file>             日志输出文件
  -v, --verbose                详细日志
  --gcInterval <ms>            手动 GC 间隔 (默认: 60000)

${clc.bold('稳定性选项:')}
  --killZombie                 自动终止僵尸连接
  --zombieTimeout <ms>         僵尸判定超时 (默认: 120000)
  --sharedTimers               共享定时器模式 (10万+连接推荐)

${clc.bold('导出选项:')}
  --export <file>              测试结果导出文件
  --exportFormat <format>      导出格式: json, csv (默认: json)

${clc.bold('示例:')}
  # 基础测试
  node ws_perf_test.js ws://localhost:9502 -c 1000 -d 60

  # 10万连接 7x24 稳定性测试（推荐配置）
  ulimit -n 200000
  node --expose-gc --max-old-space-size=8192 ws_perf_test.js \\
    ws://localhost:9502 -c 100000 -b 1000 -i 500 \\
    -r --killZombie --sharedTimers \\
    -l test.log --export result.json

  # WSS 测试（跳过证书验证）
  node ws_perf_test.js wss://localhost:9502 -c 1000 --insecure

  # 自定义 Headers
  node ws_perf_test.js ws://localhost:9502 -c 1000 \\
    --headers '{"Authorization":"Bearer token123"}'

${clc.bold('10万连接注意事项:')}
  1. 单机端口限制约 6 万，超过需多机部署
  2. 必须增加文件描述符: ulimit -n 200000
  3. 推荐启用 --sharedTimers 减少定时器开销
  4. 建议 --rateLimit 2000 防止建连过快
  5. 内存建议 8GB+: --max-old-space-size=8192
`);
}

// ========== 优雅退出 ==========
let isShuttingDown = false;

function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(statsInterval);
    clearInterval(healthCheckInterval);
    if (gcInterval) clearInterval(gcInterval);
    stopSharedTimers();

    console.log(clc.yellow('\n\n正在关闭所有连接...'));
    log(`[${new Date().toISOString()}] 开始关闭，当前活跃连接: ${activeConnections}`);

    let closedCount = 0;
    const openConns = [...connections.values()].filter(c => c.ws.readyState === WebSocket.OPEN);
    const totalToClose = openConns.length;

    if (totalToClose === 0) {
        finishShutdown();
        return;
    }

    const closeBatchSize = 1000;
    let closeIndex = 0;

    function closeBatch() {
        const batch = openConns.slice(closeIndex, closeIndex + closeBatchSize);
        batch.forEach(connMeta => {
            try {
                connMeta.ws.close(1000, 'Test completed');
            } catch (e) {
                connMeta.ws.terminate();
            }
            connMeta.ws.once('close', () => {
                closedCount++;
                if (closedCount % 1000 === 0 || closedCount >= totalToClose) {
                    process.stdout.write(`\r  已关闭: ${closedCount}/${totalToClose}`);
                }
                if (closedCount >= totalToClose) {
                    finishShutdown();
                }
            });
        });

        closeIndex += closeBatchSize;
        if (closeIndex < totalToClose) {
            setTimeout(closeBatch, 100);
        }
    }

    closeBatch();

    setTimeout(() => {
        console.log(clc.yellow(`\n超时，强制退出 (已关闭 ${closedCount}/${totalToClose})`));
        finishShutdown();
    }, 30000);
}

function finishShutdown() {
    printFinalReport();
    exportResults();
    cleanup();
}

function cleanup() {
    if (logStream) {
        logStream.end();
    }
    process.exit(0);
}

function getReportData() {
    const elapsed = Date.now() - startTime;
    const mem = getMemoryUsage();

    return {
        testDuration: elapsed,
        testDurationFormatted: formatDuration(elapsed),
        config: {
            url: config.url,
            totalConnections: config.totalConnections,
            batchSize: config.batchSize,
            messageIntervalMs: config.messageIntervalMs,
            reconnect: config.reconnect,
        },
        connections: {
            success: Number(stats.connectSuccess),
            failed: Number(stats.connectFailed),
            errors: Number(stats.errorCount),
            closed: Number(stats.closeCount),
            reconnects: Number(stats.reconnectAttempts),
            zombieKilled: Number(stats.zombieKilled),
        },
        messages: {
            sent: Number(stats.messagesSent),
            received: Number(stats.messagesReceived),
            bytesSent: Number(stats.bytesSent),
            bytesReceived: Number(stats.bytesReceived),
        },
        latency: {
            avg: getAvgLatency(),
            min: stats.minLatency === Infinity ? 0 : stats.minLatency,
            max: stats.maxLatency,
            p50: getPercentileLatency(50),
            p95: getPercentileLatency(95),
            p99: getPercentileLatency(99),
        },
        connectTime: {
            avg: getAvgConnectTime(),
        },
        performance: {
            avgSendRate: Number(stats.messagesSent) / (elapsed / 1000),
            avgReceiveRate: Number(stats.messagesReceived) / (elapsed / 1000),
        },
        memory: {
            peak: stats.peakMemory,
            final: mem.heapUsed,
        },
        errorTypes: Object.fromEntries(stats.errorTypes),
        timestamp: new Date().toISOString(),
    };
}

function printFinalReport() {
    const data = getReportData();

    const report = `
═══════════════════════════════════════════════════════════════════════
                            最终测试报告
═══════════════════════════════════════════════════════════════════════
  测试时长:       ${data.testDurationFormatted}
  目标连接数:     ${config.totalConnections.toLocaleString()}

  连接统计:
    成功连接:     ${data.connections.success.toLocaleString()}
    失败连接:     ${data.connections.failed.toLocaleString()}
    错误次数:     ${data.connections.errors.toLocaleString()}
    关闭次数:     ${data.connections.closed.toLocaleString()}
    重连次数:     ${data.connections.reconnects.toLocaleString()}
    僵尸清理:     ${data.connections.zombieKilled.toLocaleString()}

  消息统计:
    发送消息:     ${data.messages.sent.toLocaleString()}
    接收消息:     ${data.messages.received.toLocaleString()}
    发送流量:     ${formatBytes(data.messages.bytesSent)}
    接收流量:     ${formatBytes(data.messages.bytesReceived)}

  延迟统计:
    平均延迟:     ${data.latency.avg.toFixed(2)} ms
    最小延迟:     ${data.latency.min} ms
    最大延迟:     ${data.latency.max} ms
    P50 延迟:     ${data.latency.p50.toFixed(2)} ms
    P95 延迟:     ${data.latency.p95.toFixed(2)} ms
    P99 延迟:     ${data.latency.p99.toFixed(2)} ms

  连接时间:
    平均建连:     ${data.connectTime.avg.toFixed(2)} ms

  性能指标:
    平均发送速率: ${data.performance.avgSendRate.toFixed(2)} msg/s
    平均接收速率: ${data.performance.avgReceiveRate.toFixed(2)} msg/s

  内存使用:
    峰值内存:     ${formatBytes(data.memory.peak)}
    最终内存:     ${formatBytes(data.memory.final)}
═══════════════════════════════════════════════════════════════════════`;

    console.log(report);
    log(report);
}

function exportResults() {
    if (!config.exportFile) return;

    const data = getReportData();

    try {
        if (config.exportFormat === 'csv') {
            const csvContent = [
                'metric,value',
                `test_duration_ms,${data.testDuration}`,
                `connections_success,${data.connections.success}`,
                `connections_failed,${data.connections.failed}`,
                `connections_errors,${data.connections.errors}`,
                `messages_sent,${data.messages.sent}`,
                `messages_received,${data.messages.received}`,
                `bytes_sent,${data.messages.bytesSent}`,
                `bytes_received,${data.messages.bytesReceived}`,
                `latency_avg_ms,${data.latency.avg.toFixed(2)}`,
                `latency_min_ms,${data.latency.min}`,
                `latency_max_ms,${data.latency.max}`,
                `latency_p50_ms,${data.latency.p50.toFixed(2)}`,
                `latency_p95_ms,${data.latency.p95.toFixed(2)}`,
                `latency_p99_ms,${data.latency.p99.toFixed(2)}`,
                `connect_time_avg_ms,${data.connectTime.avg.toFixed(2)}`,
                `send_rate_avg,${data.performance.avgSendRate.toFixed(2)}`,
                `receive_rate_avg,${data.performance.avgReceiveRate.toFixed(2)}`,
                `memory_peak_bytes,${data.memory.peak}`,
                `memory_final_bytes,${data.memory.final}`,
            ].join('\n');
            fs.writeFileSync(config.exportFile, csvContent);
        } else {
            fs.writeFileSync(config.exportFile, JSON.stringify(data, null, 2));
        }
        console.log(clc.green(`\n结果已导出至: ${config.exportFile}`));
        log(`[${new Date().toISOString()}] 结果导出至: ${config.exportFile}`);
    } catch (e) {
        console.error(clc.red(`导出失败: ${e.message}`));
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (config.duration > 0) {
    setTimeout(() => {
        console.log(clc.yellow(`\n已达到设定的测试时长 (${config.duration}s)`));
        shutdown();
    }, config.duration * 1000);
}

// ========== 启动测试 ==========
console.clear();
console.log(clc.bold.cyan('WebSocket 长时间稳定性压测工具 v2.0 启动中...'));
console.log(clc.white(`目标: ${config.url}`));
console.log(clc.white(`计划连接数: ${config.totalConnections}, 批次: ${config.batchSize}, 间隔: ${config.batchIntervalMs}ms`));
console.log(clc.white(`重连: ${config.reconnect ? '开启' : '关闭'}, 僵尸清理: ${config.killZombie ? '开启' : '关闭'}, 日志: ${config.logFile || '关闭'}`));
if (config.rateLimit > 0) {
    console.log(clc.white(`速率限制: ${config.rateLimit} 连接/秒`));
}
if (config.exportFile) {
    console.log(clc.white(`结果导出: ${config.exportFile} (${config.exportFormat})`));
}
if (config.sharedTimers) {
    console.log(clc.green(`共享定时器: 开启 (推荐10万+连接)`));
}
console.log();

// 10万+连接提示
if (config.totalConnections >= 100000 && !config.sharedTimers) {
    console.log(clc.yellow('⚠ 提示: 10万+连接建议启用 --sharedTimers 减少定时器开销'));
    console.log();
}

log(`[${new Date().toISOString()}] 配置: ${JSON.stringify(config)}`);

connectBatch();
startSharedTimers();
