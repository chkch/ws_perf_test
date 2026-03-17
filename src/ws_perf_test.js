#!/usr/bin/env node
const clc = require('cli-color');
const WebSocket = require('ws');
const fs = require('fs');
const v8 = require('v8');

// cli-color 兼容性处理
if (!clc.gray) {
    clc.gray = clc.blackBright || clc.white;
}

// ========== 参数别名映射 ==========
const ARG_ALIASES = {
    c: 'connections',
    b: 'batch',
    i: 'interval',
    d: 'duration',
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
    duration: parseInt(args.duration || 0),
    reconnect: args.reconnect || false,
    reconnectDelay: parseInt(args.reconnectDelay || 3000),
    maxReconnectAttempts: parseInt(args.maxReconnect || 10),
    pingInterval: parseInt(args.pingInterval || 30000),
    customDataFile: args.data || null,
    logFile: args.log || null,
    gcInterval: parseInt(args.gcInterval || 60000),
    rateLimit: parseInt(args.rateLimit || 0),
    headers: args.headers ? JSON.parse(args.headers) : {},
    rejectUnauthorized: args.insecure ? false : true,
    killZombie: args.killZombie || false,
    zombieTimeout: parseInt(args.zombieTimeout || 120000),
    exportFile: args.export || null,
    exportFormat: args.exportFormat || 'json',
    subprotocol: args.subprotocol || null,
};

// 预序列化自定义消息（连接建立后只发送一次用于订阅）
let subscribePayloads = null;
if (config.customDataFile) {
    try {
        const customJSON = JSON.parse(fs.readFileSync(config.customDataFile, 'utf8'));
        if (Array.isArray(customJSON)) {
            subscribePayloads = customJSON.map(item => JSON.stringify(item));
        } else {
            subscribePayloads = [JSON.stringify(customJSON)];
        }
        console.log(clc.green(`已加载订阅消息: ${subscribePayloads.length} 条`));
    } catch (e) {
        console.error(clc.red(`无法解析 ${config.customDataFile}: ${e.message}`));
        process.exit(1);
    }
}

// ========== 统计数据 ==========
const stats = {
    connectSuccess: 0n,
    connectFailed: 0n,
    errorCount: 0n,
    closeCount: 0n,
    subscribesSent: 0n,      // 订阅消息发送数
    messagesReceived: 0n,
    bytesReceived: 0n,
    bytesSent: 0n,
    pongReceived: 0n,
    reconnectAttempts: 0n,
    zombieKilled: 0n,
    // 延迟统计
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
    lastMsgReceived: 0n,
    msgReceivedRate: 0n,
    // 内存统计
    peakMemory: 0,
    // 错误分类
    errorTypes: new Map(),
    maxErrorTypes: 50,
};

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

// ========== 延迟统计 ==========
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
    return stats.latencyCount === 0 ? 0 : stats.latencySum / stats.latencyCount;
}

function getAvgConnectTime() {
    return stats.connectTimeCount === 0 ? 0 : stats.connectTimeSum / stats.connectTimeCount;
}

function getPercentileLatency(percentile) {
    if (stats.latencyCount === 0) return 0;
    const sorted = Array.from(stats.latencyBuffer.slice(0, stats.latencyCount)).sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
}

// ========== WebSocket 关闭码描述 ==========
function getCloseCodeDesc(code) {
    const codes = {
        1000: '正常关闭',
        1001: '端点离开',
        1002: '协议错误',
        1003: '不支持的数据类型',
        1005: '无状态码',
        1006: '异常关闭(无close帧)',
        1007: '无效数据',
        1008: '策略违规',
        1009: '消息过大',
        1010: '扩展协商失败',
        1011: '服务器内部错误',
        1012: '服务重启',
        1013: '稍后重试',
        1014: '网关错误',
        1015: 'TLS握手失败',
    };
    return codes[code] || '未知';
}

// ========== 连接管理 ==========
let connectionIdCounter = 0;

function createConnection(isReconnect = false, reconnectCount = 0) {
    // 速率限制
    if (config.rateLimit > 0) {
        const now = Date.now();
        if (now - lastRateLimitRefill >= 1000) {
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
        pingTimer: null,
        lastPingTime: 0,
        lastActivityTime: Date.now(),
        reconnectCount,
        subscribed: false,
    };

    connections.set(connId, connMeta);

    // 监听底层 socket 事件，记录 TLS/连接信息
    ws.on('upgrade', (response) => {
        const socket = ws._socket;
        if (socket && socket.encrypted) {
            const cipher = socket.getCipher ? socket.getCipher() : null;
            const cert = socket.getPeerCertificate ? socket.getPeerCertificate() : null;
            const tlsInfo = [
                `[${new Date().toISOString()}] #${connId} TLS握手成功`,
                `  协议: ${socket.getProtocol ? socket.getProtocol() : 'N/A'}`,
                cipher ? `  加密套件: ${cipher.name}` : null,
                cert && cert.subject ? `  证书主体: ${cert.subject.CN || 'N/A'}` : null,
                cert && cert.valid_to ? `  证书有效期: ${cert.valid_to}` : null,
            ].filter(Boolean).join('\n');
            log(tlsInfo);
        }
    });

    ws.on('open', () => {
        const connectTime = Date.now() - connectStartTime;
        addConnectTime(connectTime);
        stats.connectSuccess++;
        activeConnections++;
        connMeta.reconnectCount = 0;
        connMeta.lastActivityTime = Date.now();

        // 发送订阅消息（只发送一次）
        if (subscribePayloads && !connMeta.subscribed) {
            for (let i = 0; i < subscribePayloads.length; i++) {
                const payload = subscribePayloads[i];
                try {
                    ws.send(payload);
                    stats.subscribesSent++;
                    stats.bytesSent += BigInt(payload.length);
                } catch (e) {
                    log(`[${new Date().toISOString()}] #${connId} 订阅消息发送失败 [${i + 1}/${subscribePayloads.length}]: ${e.message}`);
                }
            }
            connMeta.subscribed = true;
        }

        // Ping 定时器（用于保活和延迟测量）
        connMeta.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                connMeta.lastPingTime = Date.now();
                try {
                    ws.ping();
                } catch (e) {
                    log(`[${new Date().toISOString()}] #${connId} Ping发送失败: ${e.message}`);
                }
            }
        }, config.pingInterval);
        connMeta.pingTimer.unref();
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
            addLatency(Date.now() - connMeta.lastPingTime);
            connMeta.lastPingTime = 0;
        }
    });

    ws.on('error', (err) => {
        stats.errorCount++;
        const errType = err.code || err.message.split(' ')[0] || 'UNKNOWN';
        if (stats.errorTypes.size < stats.maxErrorTypes || stats.errorTypes.has(errType)) {
            stats.errorTypes.set(errType, (stats.errorTypes.get(errType) || 0) + 1);
        }
        // 详细错误日志（写入日志文件）
        const errDetails = [
            `[${new Date().toISOString()}] #${connId} WS错误`,
            `  类型: ${errType}`,
            `  消息: ${err.message}`,
            err.code ? `  错误码: ${err.code}` : null,
            err.errno ? `  errno: ${err.errno}` : null,
            err.syscall ? `  syscall: ${err.syscall}` : null,
            err.address ? `  地址: ${err.address}:${err.port || ''}` : null,
            err.hostname ? `  主机名: ${err.hostname}` : null,
            `  重连次数: ${connMeta.reconnectCount}`,
            `  连接状态: ${ws.readyState}`,
            err.stack ? `  堆栈: ${err.stack.split('\n').slice(1, 4).join(' <- ')}` : null,
        ].filter(Boolean).join('\n');
        log(errDetails);
    });

    ws.on('close', (code, reason) => {
        stats.closeCount++;
        activeConnections--;
        if (connMeta.pingTimer) {
            clearInterval(connMeta.pingTimer);
            connMeta.pingTimer = null;
        }
        connections.delete(connId);

        // 非正常关闭时记录日志
        if (code !== 1000 && code !== 1001) {
            const reasonStr = reason ? reason.toString() : '';
            const codeDesc = getCloseCodeDesc(code);
            const details = [
                `[${new Date().toISOString()}] #${connId} 连接关闭`,
                `  关闭码: ${code} (${codeDesc})`,
                reasonStr ? `  原因: ${reasonStr}` : null,
                `  存活时长: ${Date.now() - connMeta.lastActivityTime}ms`,
                `  重连次数: ${connMeta.reconnectCount}`,
                `  是否已订阅: ${connMeta.subscribed}`,
            ].filter(Boolean).join('\n');
            log(details);
        }

        // 重连
        if (config.reconnect && !isShuttingDown && code !== 1000) {
            if (reconnectCount < config.maxReconnectAttempts) {
                stats.reconnectAttempts++;
                const delay = Math.min(config.reconnectDelay * Math.pow(1.5, reconnectCount), 30000);
                setTimeout(() => {
                    if (!isShuttingDown) createConnection(true, reconnectCount + 1);
                }, delay);
            } else {
                log(`[${new Date().toISOString()}] #${connId} 达到最大重连次数 ${config.maxReconnectAttempts}，放弃重连`);
            }
        }
    });

    ws.on('unexpected-response', (req, res) => {
        stats.connectFailed++;
        stats.errorTypes.set(`HTTP_${res.statusCode}`, (stats.errorTypes.get(`HTTP_${res.statusCode}`) || 0) + 1);
        // 详细 HTTP 错误日志
        let responseBody = '';
        res.on('data', chunk => { responseBody += chunk.toString().slice(0, 500); });
        res.on('end', () => {
            const details = [
                `[${new Date().toISOString()}] #${connId} HTTP握手失败`,
                `  状态码: ${res.statusCode} ${res.statusMessage || ''}`,
                `  请求URL: ${config.url}`,
                `  响应头: ${JSON.stringify(res.headers || {}).slice(0, 300)}`,
                responseBody ? `  响应体: ${responseBody.slice(0, 200)}` : null,
            ].filter(Boolean).join('\n');
            log(details);
        });
    });

    return connMeta;
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

// ========== 格式化函数 ==========
function formatBytes(bytes) {
    const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
}

function formatNum(n) {
    return Number(n).toLocaleString();
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d${h % 24}h${m % 60}m`;
    if (h > 0) return `${h}h${m % 60}m${s % 60}s`;
    if (m > 0) return `${m}m${s % 60}s`;
    return `${s}s`;
}

function getMemoryUsage() {
    const usage = process.memoryUsage();
    if (usage.heapUsed > stats.peakMemory) stats.peakMemory = usage.heapUsed;
    return usage;
}

// ========== 状态显示 ==========
function printStats() {
    const elapsed = Date.now() - startTime;
    const mem = getMemoryUsage();

    stats.msgReceivedRate = stats.messagesReceived - stats.lastMsgReceived;
    stats.lastMsgReceived = stats.messagesReceived;

    const heapStats = v8.getHeapStatistics();
    const connPct = ((activeConnections / config.totalConnections) * 100).toFixed(1);
    const avgLat = getAvgLatency().toFixed(1);
    const minLat = stats.minLatency === Infinity ? '-' : stats.minLatency;
    const maxLat = stats.maxLatency === 0 ? '-' : stats.maxLatency;
    const p50 = getPercentileLatency(50).toFixed(1);
    const p95 = getPercentileLatency(95).toFixed(1);
    const p99 = getPercentileLatency(99).toFixed(1);
    const heapPct = ((mem.heapUsed / heapStats.heap_size_limit) * 100).toFixed(1);

    console.clear();
    console.log(clc.bold.cyan('┌─────────────────────────────────────────────────────────────────────────────────────┐'));
    console.log(clc.bold.cyan('│') + clc.bold.white('                       WebSocket 稳定性压测工具 v2.1                                ') + clc.bold.cyan('│'));
    console.log(clc.bold.cyan('├─────────────────────────────────────────────────────────────────────────────────────┤'));

    // 基本信息
    const durationStr = config.duration > 0 ? ` / ${formatDuration(config.duration * 1000)}` : '';
    console.log(clc.bold.cyan('│') + `  ${clc.white('目标:')} ${clc.yellow(config.url)}`);
    console.log(clc.bold.cyan('│') + `  ${clc.white('运行:')} ${clc.bold.yellow(formatDuration(elapsed))}${clc.gray(durationStr)}`);

    console.log(clc.bold.cyan('├─────────────────────────────────────────────────────────────────────────────────────┤'));

    // 连接状态
    console.log(clc.bold.cyan('│') + `  ${clc.bold.green('▌连接')}  ${clc.green('●')} 活跃: ${clc.bold.white(activeConnections.toLocaleString())}/${config.totalConnections.toLocaleString()} (${connPct}%)` +
        `   ${clc.green('✓')} 成功: ${clc.white(formatNum(stats.connectSuccess))}` +
        `   ${clc.red('✗')} 失败: ${clc.white(formatNum(stats.connectFailed))}` +
        `   ${clc.yellow('⚠')} 错误: ${clc.white(formatNum(stats.errorCount))}`);
    console.log(clc.bold.cyan('│') + `          ${clc.gray('○')} 关闭: ${clc.white(formatNum(stats.closeCount))}` +
        `   ${clc.cyan('↻')} 重连: ${clc.white(formatNum(stats.reconnectAttempts))}` +
        `   ${clc.gray('⏱')} 建连均时: ${clc.white(getAvgConnectTime().toFixed(1))} ms`);

    console.log(clc.bold.cyan('├─────────────────────────────────────────────────────────────────────────────────────┤'));

    // 消息统计
    console.log(clc.bold.cyan('│') + `  ${clc.bold.blue('▌消息')}  ${clc.cyan('↑')} 订阅发送: ${clc.white(formatNum(stats.subscribesSent))}` +
        `   ${clc.cyan('↓')} 接收: ${clc.white(formatNum(stats.messagesReceived))} (${clc.green(formatNum(stats.msgReceivedRate) + '/s')})` +
        `   ${clc.cyan('⇅')} 流量: ↑${clc.white(formatBytes(stats.bytesSent))} / ↓${clc.white(formatBytes(stats.bytesReceived))}`);

    console.log(clc.bold.cyan('├─────────────────────────────────────────────────────────────────────────────────────┤'));

    // 延迟统计
    console.log(clc.bold.cyan('│') + `  ${clc.bold.magenta('▌延迟')}  avg: ${clc.white(avgLat)} ms` +
        `   min: ${clc.white(minLat)} ms` +
        `   max: ${clc.white(maxLat)} ms` +
        `   ${clc.magenta('P50:')} ${clc.white(p50)} ms` +
        `   ${clc.magenta('P95:')} ${clc.white(p95)} ms` +
        `   ${clc.magenta('P99:')} ${clc.white(p99)} ms`);

    console.log(clc.bold.cyan('├─────────────────────────────────────────────────────────────────────────────────────┤'));

    // 系统资源
    console.log(clc.bold.cyan('│') + `  ${clc.bold.yellow('▌资源')}  堆内存: ${clc.white(formatBytes(mem.heapUsed))} / ${formatBytes(heapStats.heap_size_limit)} (${heapPct}%)` +
        `   峰值: ${clc.white(formatBytes(stats.peakMemory))}` +
        `   RSS: ${clc.white(formatBytes(mem.rss))}`);

    // 错误类型
    if (stats.errorTypes.size > 0) {
        console.log(clc.bold.cyan('├─────────────────────────────────────────────────────────────────────────────────────┤'));
        const topErrors = [...stats.errorTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        const errStr = topErrors.map(([t, c]) => `${t}: ${c}`).join('   ');
        console.log(clc.bold.cyan('│') + `  ${clc.bold.red('▌错误')}  ${clc.white(errStr)}`);
    }

    console.log(clc.bold.cyan('├─────────────────────────────────────────────────────────────────────────────────────┤'));
    console.log(clc.bold.cyan('│') + clc.gray(`  Ctrl+C 退出  │  重连: ${config.reconnect ? '开' : '关'}  │  僵尸清理: ${config.killZombie ? '开' : '关'}  │  日志: ${config.logFile || '关'}`));
    console.log(clc.bold.cyan('└─────────────────────────────────────────────────────────────────────────────────────┘'));

    // 日志
    const now = Date.now();
    if (logStream && now - lastLogTime >= 60000) {
        lastLogTime = now;
        log(`[${new Date().toISOString()}] 活跃=${activeConnections} 订阅=${stats.subscribesSent} 接收=${stats.messagesReceived} 延迟=${avgLat}ms 内存=${formatBytes(mem.heapUsed)}`);
    }
}

const statsInterval = setInterval(printStats, 1000);

// ========== GC ==========
let gcInterval = null;
if (global.gc) {
    gcInterval = setInterval(() => {
        global.gc();
        log(`[${new Date().toISOString()}] GC`);
    }, config.gcInterval);
    gcInterval.unref();
}

// ========== 健康检查 ==========
const healthCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, connMeta] of connections) {
        if (connMeta.ws.readyState === WebSocket.OPEN && now - connMeta.lastActivityTime > config.zombieTimeout) {
            if (config.killZombie) {
                log(`[${new Date().toISOString()}] #${id} 僵尸连接清理 - 无活动时长: ${now - connMeta.lastActivityTime}ms`);
                connMeta.ws.terminate();
                stats.zombieKilled++;
            }
        }
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
            const fullKey = ARG_ALIASES[shortKey] || shortKey;
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
${clc.bold.cyan('WebSocket 稳定性压测工具 v2.1')}

${clc.bold('用法:')}
  node ws_perf_test.js [url] [选项]

${clc.bold('连接选项:')}
  -c, --connections <num>      总连接数 (默认: 10000)
  -b, --batch <num>            每批连接数 (默认: 500)
  -i, --interval <ms>          批次间隔 (默认: 1000)
  -r, --reconnect              启用断线重连
  --reconnectDelay <ms>        重连延迟 (默认: 3000)
  --maxReconnect <num>         最大重连次数 (默认: 10)
  --rateLimit <num>            每秒最大新建连接数 (默认: 0=不限)

${clc.bold('消息选项:')}
  --data <file>                订阅消息JSON文件（连接后只发送一次）
  --pingInterval <ms>          Ping间隔 (默认: 30000)

${clc.bold('安全选项:')}
  --insecure                   跳过WSS证书验证
  --headers <json>             自定义HTTP Headers
  --subprotocol <name>         WebSocket子协议

${clc.bold('测试选项:')}
  -d, --duration <seconds>     测试时长，0=无限 (默认: 0)
  -l, --log <file>             日志文件（包含详细错误信息）
  --killZombie                 自动清理僵尸连接
  --zombieTimeout <ms>         僵尸判定超时 (默认: 120000)

${clc.bold('导出选项:')}
  --export <file>              结果导出文件
  --exportFormat <format>      导出格式: json, csv

${clc.bold('示例:')}
  # 基础测试
  node ws_perf_test.js ws://localhost:9502 -c 1000 -d 60

  # 5万连接订阅测试
  ulimit -n 100000
  node --expose-gc --max-old-space-size=4096 ws_perf_test.js \\
    ws://server:9502 -c 50000 -b 500 --data subscribe.json -r -l test.log

  # subscribe.json 示例:
  # {"action":"subscribe","channel":"market"} 或
  # [{"action":"sub","ch":"ch1"},{"action":"sub","ch":"ch2"}]
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

    console.log(clc.yellow('\n\n正在关闭所有连接...'));
    log(`[${new Date().toISOString()}] 关闭中，活跃: ${activeConnections}`);

    let closedCount = 0;
    const openConns = [...connections.values()].filter(c => c.ws.readyState === WebSocket.OPEN);
    const total = openConns.length;

    if (total === 0) {
        finishShutdown();
        return;
    }

    const batchSize = 1000;
    let idx = 0;

    function closeBatch() {
        const batch = openConns.slice(idx, idx + batchSize);
        batch.forEach(c => {
            try { c.ws.close(1000, 'done'); } catch { c.ws.terminate(); }
            c.ws.once('close', () => {
                closedCount++;
                if (closedCount % 1000 === 0 || closedCount >= total) {
                    process.stdout.write(`\r  已关闭: ${closedCount}/${total}`);
                }
                if (closedCount >= total) finishShutdown();
            });
        });
        idx += batchSize;
        if (idx < total) setTimeout(closeBatch, 100);
    }

    closeBatch();
    setTimeout(() => {
        console.log(clc.yellow(`\n超时退出 (${closedCount}/${total})`));
        finishShutdown();
    }, 30000);
}

function finishShutdown() {
    printFinalReport();
    exportResults();
    if (logStream) logStream.end();
    process.exit(0);
}

function getReportData() {
    const elapsed = Date.now() - startTime;
    const mem = getMemoryUsage();
    return {
        testDuration: elapsed,
        testDurationFormatted: formatDuration(elapsed),
        connections: {
            success: Number(stats.connectSuccess),
            failed: Number(stats.connectFailed),
            errors: Number(stats.errorCount),
            closed: Number(stats.closeCount),
            reconnects: Number(stats.reconnectAttempts),
        },
        messages: {
            subscribesSent: Number(stats.subscribesSent),
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
        memory: { peak: stats.peakMemory, final: mem.heapUsed },
        errorTypes: Object.fromEntries(stats.errorTypes),
    };
}

function printFinalReport() {
    const d = getReportData();
    const recvRate = (d.messages.received / (d.testDuration / 1000)).toFixed(2);

    console.log(`
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                   最终测试报告                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  测试时长: ${d.testDurationFormatted.padEnd(12)}                 目标连接数: ${config.totalConnections.toLocaleString().padEnd(10)}                       │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  ▌连接    成功: ${String(d.connections.success).padEnd(8)}  失败: ${String(d.connections.failed).padEnd(6)}  错误: ${String(d.connections.errors).padEnd(6)}  关闭: ${String(d.connections.closed).padEnd(8)}  重连: ${String(d.connections.reconnects).padEnd(6)} │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  ▌消息    订阅发送: ${String(d.messages.subscribesSent).padEnd(10)}  接收: ${String(d.messages.received).padEnd(12)}  流量: ↑${formatBytes(d.messages.bytesSent).padEnd(8)} / ↓${formatBytes(d.messages.bytesReceived).padEnd(8)} │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  ▌延迟    avg: ${d.latency.avg.toFixed(2).padEnd(6)}ms  min: ${String(d.latency.min).padEnd(4)}ms  max: ${String(d.latency.max).padEnd(5)}ms  P50: ${d.latency.p50.toFixed(2).padEnd(6)}ms  P95: ${d.latency.p95.toFixed(2).padEnd(6)}ms  P99: ${d.latency.p99.toFixed(2).padEnd(6)}ms │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  ▌内存    峰值: ${formatBytes(d.memory.peak).padEnd(10)}              最终: ${formatBytes(d.memory.final).padEnd(10)}                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  ▌性能    平均接收速率: ${recvRate.padEnd(12)} msg/s                                                    │
└─────────────────────────────────────────────────────────────────────────────────────┘`);
    log(`[${new Date().toISOString()}] 报告: ${JSON.stringify(d)}`);
}

function exportResults() {
    if (!config.exportFile) return;
    const data = getReportData();
    try {
        if (config.exportFormat === 'csv') {
            const csv = Object.entries({
                duration_ms: data.testDuration,
                conn_success: data.connections.success,
                conn_failed: data.connections.failed,
                subscribes_sent: data.messages.subscribesSent,
                msg_received: data.messages.received,
                latency_avg: data.latency.avg.toFixed(2),
                latency_p99: data.latency.p99.toFixed(2),
            }).map(([k, v]) => `${k},${v}`).join('\n');
            fs.writeFileSync(config.exportFile, 'metric,value\n' + csv);
        } else {
            fs.writeFileSync(config.exportFile, JSON.stringify(data, null, 2));
        }
        console.log(clc.green(`结果导出: ${config.exportFile}`));
    } catch (e) {
        console.error(clc.red(`导出失败: ${e.message}`));
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (config.duration > 0) {
    setTimeout(() => {
        console.log(clc.yellow(`\n测试时长已到 (${config.duration}s)`));
        shutdown();
    }, config.duration * 1000);
}

// ========== 启动 ==========
console.clear();
console.log(clc.bold.cyan('WebSocket 稳定性压测工具 v2.1'));
console.log(`目标: ${config.url}`);
console.log(`连接: ${config.totalConnections} 批次: ${config.batchSize} 间隔: ${config.batchIntervalMs}ms`);
if (subscribePayloads) {
    console.log(clc.green(`订阅消息: ${subscribePayloads.length} 条 (每连接只发送一次)`));
}
console.log();

log(`[${new Date().toISOString()}] 配置: ${JSON.stringify(config)}`);
connectBatch();
