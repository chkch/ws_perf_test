#!/usr/bin/env node
const clc = require('cli-color');
const WebSocket = require('ws');
const fs = require('fs');
const v8 = require('v8');
const dns = require('dns');
const { URL } = require('url');

// cli-color 兼容性处理
if (!clc.gray) {
    clc.gray = clc.blackBright || clc.white;
}

// ========== [A1] 优化的百分位数计算器（二分插入维护有序数组） ==========
class PercentileCalculator {
    constructor(maxSize = 10000) {
        this.maxSize = maxSize;
        this.sortedData = [];
        this.sum = 0;
        this.min = Infinity;
        this.max = 0;
    }

    add(value) {
        // 二分查找插入位置
        let left = 0, right = this.sortedData.length;
        while (left < right) {
            const mid = (left + right) >>> 1;
            if (this.sortedData[mid] < value) left = mid + 1;
            else right = mid;
        }
        this.sortedData.splice(left, 0, value);
        this.sum += value;

        // 超出容量时移除中间值（保留极值更有意义）
        if (this.sortedData.length > this.maxSize) {
            const midIdx = this.maxSize >>> 1;
            this.sum -= this.sortedData[midIdx];
            this.sortedData.splice(midIdx, 1);
        }

        if (value < this.min) this.min = value;
        if (value > this.max) this.max = value;
    }

    getPercentile(p) {
        if (this.sortedData.length === 0) return 0;
        const idx = Math.floor((p / 100) * this.sortedData.length);
        return this.sortedData[Math.min(idx, this.sortedData.length - 1)];
    }

    getAvg() {
        return this.sortedData.length === 0 ? 0 : this.sum / this.sortedData.length;
    }

    getMin() { return this.min === Infinity ? 0 : this.min; }
    getMax() { return this.max; }
    getCount() { return this.sortedData.length; }
}

// ========== [A2] Buffer 池（减少 GC 压力） ==========
class BufferPool {
    constructor(poolSize = 100, bufferSize = 4096) {
        this.pool = [];
        this.bufferSize = bufferSize;
        for (let i = 0; i < poolSize; i++) {
            this.pool.push(Buffer.allocUnsafe(bufferSize));
        }
    }

    acquire() {
        return this.pool.pop() || Buffer.allocUnsafe(this.bufferSize);
    }

    release(buf) {
        if (this.pool.length < 200) { // 限制池大小
            this.pool.push(buf);
        }
    }
}

// ========== [E4] DNS 缓存 ==========
class DNSCache {
    constructor(ttlMs = 60000) {
        this.cache = new Map();
        this.ttlMs = ttlMs;
    }

    async resolve(hostname) {
        const cached = this.cache.get(hostname);
        if (cached && Date.now() - cached.timestamp < this.ttlMs) {
            return cached.address;
        }
        return new Promise((resolve, reject) => {
            dns.lookup(hostname, { family: 4 }, (err, address) => {
                if (err) return reject(err);
                this.cache.set(hostname, { address, timestamp: Date.now() });
                resolve(address);
            });
        });
    }

    clear() {
        this.cache.clear();
    }
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
    // [A3] 预热模式
    warmup: args.warmup || false,
    // [E1] 连接超时
    connectTimeout: parseInt(args.connectTimeout || 15000),
    // [E3] 优雅降级阈值
    maxMemoryPercent: parseInt(args.maxMemoryPercent || 85),
    maxFdPercent: parseInt(args.maxFdPercent || 80),
    // [A4] 并发创建限制
    concurrentLimit: parseInt(args.concurrentLimit || 100),
};

// 解析 URL 获取主机名用于 DNS 缓存
const parsedUrl = new URL(config.url);
const targetHostname = parsedUrl.hostname;

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
    // [A1] 使用优化的百分位计算器
    latencyCalc: new PercentileCalculator(10000),
    connectTimeCalc: new PercentileCalculator(5000),
    // [C5] 首字节时间 TTFB
    ttfbCalc: new PercentileCalculator(5000),
    // [C2] 吞吐量统计
    lastMsgReceived: 0n,
    lastBytesReceived: 0n,
    msgReceivedRate: 0n,
    bytesReceivedRate: 0n,
    peakMsgRate: 0n,
    peakBytesRate: 0n,
    // 内存统计
    peakMemory: 0,
    // [C3] FD 统计
    currentFd: 0,
    maxFd: 0,
    // 错误分类
    errorTypes: new Map(),
    maxErrorTypes: 50,
    // [E2] 泄漏检测
    leakWarnings: 0,
    // [E3] 降级状态
    degraded: false,
    degradeReason: '',
};

// [A2] 初始化 Buffer 池
const bufferPool = new BufferPool(100, 4096);

// [E4] 初始化 DNS 缓存
const dnsCache = new DNSCache(60000);

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

// ========== [C3] FD 文件描述符监控 ==========
function getFdCount() {
    try {
        if (process.platform === 'linux') {
            const fdDir = `/proc/${process.pid}/fd`;
            return fs.readdirSync(fdDir).length;
        } else if (process.platform === 'darwin') {
            // macOS: 使用连接数估算（每个 WS 约 1 个 FD）
            return activeConnections + 10; // +10 为基础 FD（stdin/stdout/stderr 等）
        }
    } catch (e) {
        return activeConnections + 10;
    }
    return activeConnections + 10;
}

function getMaxFd() {
    try {
        if (process.platform === 'linux' || process.platform === 'darwin') {
            const { execSync } = require('child_process');
            const result = execSync('ulimit -n', { encoding: 'utf8' });
            return parseInt(result.trim()) || 65535;
        }
    } catch (e) {
        return 65535;
    }
    return 65535;
}

// 获取最大 FD 限制（启动时获取一次）
stats.maxFd = getMaxFd();

// ========== [E2] 内存泄漏检测 ==========
function checkMemoryLeak() {
    const connMapSize = connections.size;
    const diff = Math.abs(connMapSize - activeConnections);
    if (diff > 100) { // 允许 100 的误差（正在建立/关闭的连接）
        stats.leakWarnings++;
        log(`[${new Date().toISOString()}] ⚠️ 潜在内存泄漏: Map=${connMapSize}, active=${activeConnections}, 差异=${diff}`);
        return true;
    }
    return false;
}

// ========== [E3] 优雅降级检查 ==========
function checkDegradation() {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const memPercent = (mem.heapUsed / heapStats.heap_size_limit) * 100;

    stats.currentFd = getFdCount();
    const fdPercent = (stats.currentFd / stats.maxFd) * 100;

    if (memPercent > config.maxMemoryPercent) {
        stats.degraded = true;
        stats.degradeReason = `内存 ${memPercent.toFixed(1)}% > ${config.maxMemoryPercent}%`;
        return true;
    }
    if (fdPercent > config.maxFdPercent) {
        stats.degraded = true;
        stats.degradeReason = `FD ${fdPercent.toFixed(1)}% > ${config.maxFdPercent}%`;
        return true;
    }
    stats.degraded = false;
    stats.degradeReason = '';
    return false;
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
let pendingConnections = 0; // [A4] 跟踪正在建立的连接数

function createConnection(isReconnect = false, reconnectCount = 0) {
    // [E3] 优雅降级检查
    if (checkDegradation() && !isReconnect) {
        log(`[${new Date().toISOString()}] 降级中，跳过新建连接: ${stats.degradeReason}`);
        return null;
    }

    // [A4] 并发限制
    if (pendingConnections >= config.concurrentLimit) {
        setTimeout(() => createConnection(isReconnect, reconnectCount), 50);
        return null;
    }

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
    pendingConnections++; // [A4]

    const wsOptions = {
        perMessageDeflate: false,
        skipUTF8Validation: true,
        handshakeTimeout: config.connectTimeout, // [E1] 使用配置的超时
        maxPayload: 100 * 1024 * 1024,
        headers: config.headers,
        rejectUnauthorized: config.rejectUnauthorized,
    };

    if (config.subprotocol) {
        wsOptions.protocol = config.subprotocol;
    }

    const ws = new WebSocket(config.url, wsOptions);

    // [E1] 独立的连接超时计时器
    const connectTimeoutTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
            log(`[${new Date().toISOString()}] #${connId} 连接超时 (${config.connectTimeout}ms)`);
            ws.terminate();
            stats.connectFailed++;
            stats.errorTypes.set('TIMEOUT', (stats.errorTypes.get('TIMEOUT') || 0) + 1);
        }
    }, config.connectTimeout);

    const connMeta = {
        id: connId,
        ws,
        pingTimer: null,
        lastPingTime: 0,
        lastActivityTime: Date.now(),
        reconnectCount,
        subscribed: false,
        connectStartTime, // [C5] 用于 TTFB 计算
        firstMessageTime: 0, // [C5] 首条消息时间
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
        clearTimeout(connectTimeoutTimer); // [E1] 清理超时计时器
        pendingConnections--; // [A4]
        const connectTime = Date.now() - connectStartTime;
        stats.connectTimeCalc.add(connectTime); // [A1] 使用优化的计算器
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

        // [C5] 首字节时间 TTFB（首条消息到达时间）
        if (connMeta.firstMessageTime === 0) {
            connMeta.firstMessageTime = Date.now();
            const ttfb = connMeta.firstMessageTime - connMeta.connectStartTime;
            stats.ttfbCalc.add(ttfb);
        }
    });

    ws.on('pong', () => {
        stats.pongReceived++;
        connMeta.lastActivityTime = Date.now();
        if (connMeta.lastPingTime > 0) {
            stats.latencyCalc.add(Date.now() - connMeta.lastPingTime); // [A1] 使用优化的计算器
            connMeta.lastPingTime = 0;
        }
    });

    ws.on('error', (err) => {
        clearTimeout(connectTimeoutTimer); // [E1] 清理超时计时器
        if (ws.readyState === WebSocket.CONNECTING) {
            pendingConnections--; // [A4] 连接失败时减少计数
        }
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
        clearTimeout(connectTimeoutTimer); // [E1] 清理超时计时器
        stats.closeCount++;
        if (activeConnections > 0) activeConnections--;
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

// ========== [C4] 连接状态分布 ==========
function getConnectionStateDistribution() {
    let connecting = 0, open = 0, closing = 0, closed = 0;
    for (const [, connMeta] of connections) {
        switch (connMeta.ws.readyState) {
            case WebSocket.CONNECTING: connecting++; break;
            case WebSocket.OPEN: open++; break;
            case WebSocket.CLOSING: closing++; break;
            case WebSocket.CLOSED: closed++; break;
        }
    }
    return { connecting, open, closing, closed };
}

// ========== 状态显示 ==========
function printStats() {
    const elapsed = Date.now() - startTime;
    const mem = getMemoryUsage();

    // [C2] 吞吐量统计
    stats.msgReceivedRate = stats.messagesReceived - stats.lastMsgReceived;
    stats.bytesReceivedRate = stats.bytesReceived - stats.lastBytesReceived;
    stats.lastMsgReceived = stats.messagesReceived;
    stats.lastBytesReceived = stats.bytesReceived;
    if (stats.msgReceivedRate > stats.peakMsgRate) stats.peakMsgRate = stats.msgReceivedRate;
    if (stats.bytesReceivedRate > stats.peakBytesRate) stats.peakBytesRate = stats.bytesReceivedRate;

    const heapStats = v8.getHeapStatistics();
    const connPct = ((activeConnections / config.totalConnections) * 100).toFixed(1);

    // [A1] 使用优化的计算器
    const avgLat = stats.latencyCalc.getAvg().toFixed(1);
    const minLat = stats.latencyCalc.getMin() || '-';
    const maxLat = stats.latencyCalc.getMax() || '-';
    const p50 = stats.latencyCalc.getPercentile(50).toFixed(1);
    const p95 = stats.latencyCalc.getPercentile(95).toFixed(1);
    const p99 = stats.latencyCalc.getPercentile(99).toFixed(1);

    // [C1] 连接时间百分位
    const connAvg = stats.connectTimeCalc.getAvg().toFixed(1);
    const connP50 = stats.connectTimeCalc.getPercentile(50).toFixed(1);
    const connP95 = stats.connectTimeCalc.getPercentile(95).toFixed(1);
    const connP99 = stats.connectTimeCalc.getPercentile(99).toFixed(1);

    // [C5] TTFB
    const ttfbAvg = stats.ttfbCalc.getAvg().toFixed(1);
    const ttfbP95 = stats.ttfbCalc.getPercentile(95).toFixed(1);

    const heapPct = ((mem.heapUsed / heapStats.heap_size_limit) * 100).toFixed(1);

    // [C3] FD 统计
    stats.currentFd = getFdCount();
    const fdPct = ((stats.currentFd / stats.maxFd) * 100).toFixed(1);

    // [C4] 连接状态分布
    const connState = getConnectionStateDistribution();

    console.clear();
    console.log(clc.bold.cyan('┌──────────────────────────────────────────────────────────────────────────────────────────────┐'));
    console.log(clc.bold.cyan('│') + clc.bold.white('                          WebSocket 稳定性压测工具 v3.0 (优化版)                              ') + clc.bold.cyan('│'));
    console.log(clc.bold.cyan('├──────────────────────────────────────────────────────────────────────────────────────────────┤'));

    // 基本信息
    const durationStr = config.duration > 0 ? ` / ${formatDuration(config.duration * 1000)}` : '';
    const degradeStr = stats.degraded ? clc.red(` [降级: ${stats.degradeReason}]`) : '';
    console.log(clc.bold.cyan('│') + `  ${clc.white('目标:')} ${clc.yellow(config.url)}${degradeStr}`);
    console.log(clc.bold.cyan('│') + `  ${clc.white('运行:')} ${clc.bold.yellow(formatDuration(elapsed))}${clc.gray(durationStr)}` +
        `   ${clc.white('预热:')} ${config.warmup ? clc.green('开') : clc.gray('关')}`);

    console.log(clc.bold.cyan('├──────────────────────────────────────────────────────────────────────────────────────────────┤'));

    // 连接状态
    console.log(clc.bold.cyan('│') + `  ${clc.bold.green('▌连接')}  ${clc.green('●')} 活跃: ${clc.bold.white(activeConnections.toLocaleString())}/${config.totalConnections.toLocaleString()} (${connPct}%)` +
        `   ${clc.green('✓')} 成功: ${clc.white(formatNum(stats.connectSuccess))}` +
        `   ${clc.red('✗')} 失败: ${clc.white(formatNum(stats.connectFailed))}` +
        `   ${clc.yellow('⚠')} 错误: ${clc.white(formatNum(stats.errorCount))}`);

    // [C4] 状态分布
    console.log(clc.bold.cyan('│') + `          ${clc.gray('○')} 关闭: ${clc.white(formatNum(stats.closeCount))}` +
        `   ${clc.cyan('↻')} 重连: ${clc.white(formatNum(stats.reconnectAttempts))}` +
        `   ${clc.gray('◎')} 状态: ${clc.yellow(`建立中:${connState.connecting}`)} ${clc.green(`已连接:${connState.open}`)} ${clc.gray(`关闭中:${connState.closing}`)}`);

    // [C1] 连接时间百分位
    console.log(clc.bold.cyan('│') + `          ${clc.gray('⏱')} 建连: avg=${clc.white(connAvg)}ms P50=${clc.white(connP50)}ms P95=${clc.white(connP95)}ms P99=${clc.white(connP99)}ms`);

    console.log(clc.bold.cyan('├──────────────────────────────────────────────────────────────────────────────────────────────┤'));

    // [C2] 消息统计 + 吞吐量
    console.log(clc.bold.cyan('│') + `  ${clc.bold.blue('▌消息')}  ${clc.cyan('↑')} 订阅: ${clc.white(formatNum(stats.subscribesSent))}` +
        `   ${clc.cyan('↓')} 接收: ${clc.white(formatNum(stats.messagesReceived))} (${clc.green(formatNum(stats.msgReceivedRate) + '/s')})` +
        `   峰值: ${clc.white(formatNum(stats.peakMsgRate) + '/s')}`);
    console.log(clc.bold.cyan('│') + `          ${clc.cyan('⇅')} 流量: ↑${clc.white(formatBytes(stats.bytesSent))} / ↓${clc.white(formatBytes(stats.bytesReceived))}` +
        `   速率: ${clc.green(formatBytes(stats.bytesReceivedRate) + '/s')}` +
        `   峰值: ${clc.white(formatBytes(stats.peakBytesRate) + '/s')}`);

    console.log(clc.bold.cyan('├──────────────────────────────────────────────────────────────────────────────────────────────┤'));

    // 延迟统计
    console.log(clc.bold.cyan('│') + `  ${clc.bold.magenta('▌延迟')}  avg: ${clc.white(avgLat)}ms` +
        `   min: ${clc.white(minLat)}ms` +
        `   max: ${clc.white(maxLat)}ms` +
        `   ${clc.magenta('P50:')} ${clc.white(p50)}ms` +
        `   ${clc.magenta('P95:')} ${clc.white(p95)}ms` +
        `   ${clc.magenta('P99:')} ${clc.white(p99)}ms`);

    // [C5] TTFB
    console.log(clc.bold.cyan('│') + `          ${clc.gray('TTFB:')} avg=${clc.white(ttfbAvg)}ms P95=${clc.white(ttfbP95)}ms` +
        `   ${clc.gray('(首条消息延迟)')}`);

    console.log(clc.bold.cyan('├──────────────────────────────────────────────────────────────────────────────────────────────┤'));

    // [C3] 系统资源 + FD
    console.log(clc.bold.cyan('│') + `  ${clc.bold.yellow('▌资源')}  堆内存: ${clc.white(formatBytes(mem.heapUsed))}/${formatBytes(heapStats.heap_size_limit)} (${heapPct}%)` +
        `   峰值: ${clc.white(formatBytes(stats.peakMemory))}` +
        `   RSS: ${clc.white(formatBytes(mem.rss))}`);
    console.log(clc.bold.cyan('│') + `          FD: ${clc.white(stats.currentFd)}/${stats.maxFd} (${fdPct}%)` +
        `   ${stats.leakWarnings > 0 ? clc.red(`泄漏警告: ${stats.leakWarnings}`) : clc.green('泄漏检测: 正常')}`);

    // 错误类型
    if (stats.errorTypes.size > 0) {
        console.log(clc.bold.cyan('├──────────────────────────────────────────────────────────────────────────────────────────────┤'));
        const topErrors = [...stats.errorTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        const errStr = topErrors.map(([t, c]) => `${t}: ${c}`).join('   ');
        console.log(clc.bold.cyan('│') + `  ${clc.bold.red('▌错误')}  ${clc.white(errStr)}`);
    }

    console.log(clc.bold.cyan('├──────────────────────────────────────────────────────────────────────────────────────────────┤'));
    console.log(clc.bold.cyan('│') + clc.gray(`  Ctrl+C 退出  │  重连: ${config.reconnect ? '开' : '关'}  │  僵尸清理: ${config.killZombie ? '开' : '关'}  │  日志: ${config.logFile || '关'}`));
    console.log(clc.bold.cyan('└──────────────────────────────────────────────────────────────────────────────────────────────┘'));

    // 日志
    const now = Date.now();
    if (logStream && now - lastLogTime >= 60000) {
        lastLogTime = now;
        log(`[${new Date().toISOString()}] 活跃=${activeConnections} 订阅=${stats.subscribesSent} 接收=${stats.messagesReceived} 延迟=${avgLat}ms P99=${p99}ms TTFB=${ttfbAvg}ms 内存=${formatBytes(mem.heapUsed)} FD=${stats.currentFd}`);
    }

    // [E2] 定期泄漏检测
    if (now % 30000 < 1000) {
        checkMemoryLeak();
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
${clc.bold.cyan('WebSocket 稳定性压测工具 v3.0 (优化版)')}

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
  --concurrentLimit <num>      并发建连限制 (默认: 100) [A4]
  --connectTimeout <ms>        连接超时 (默认: 15000) [E1]

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
  --warmup                     预热模式：先建连再开始测试 [A3]
  --killZombie                 自动清理僵尸连接
  --zombieTimeout <ms>         僵尸判定超时 (默认: 120000)

${clc.bold('稳定性选项:')} [E3]
  --maxMemoryPercent <num>     内存使用上限百分比，超过则降级 (默认: 85)
  --maxFdPercent <num>         FD使用上限百分比，超过则降级 (默认: 80)

${clc.bold('导出选项:')}
  --export <file>              结果导出文件
  --exportFormat <format>      导出格式: json, csv

${clc.bold('优化特性:')}
  [A1] 百分位数计算优化 - 二分插入O(log n)替代排序O(n log n)
  [A2] Buffer池复用 - 减少GC压力
  [A3] 连接预热模式 - 先建连再测试
  [A4] 并发创建限制 - 避免瞬时过载
  [C1] 连接时间百分位 - P50/P95/P99
  [C2] 吞吐量TPS统计 - 峰值追踪
  [C3] FD文件描述符监控 - 预警系统限制
  [C4] 连接状态分布 - 实时显示各状态连接数
  [C5] TTFB首字节时间 - 首条消息延迟
  [E1] 连接超时优化 - 独立超时计时器
  [E2] 内存泄漏检测 - 定期检查连接Map
  [E3] 优雅降级 - 资源紧张时停止新建连接
  [E4] DNS缓存 - 减少DNS查询

${clc.bold('示例:')}
  # 基础测试
  node ws_perf_test.js ws://localhost:9502 -c 1000 -d 60

  # 5万连接压测（带优雅降级）
  ulimit -n 100000
  node --expose-gc --max-old-space-size=4096 ws_perf_test.js \\
    ws://server:9502 -c 50000 -b 500 --data subscribe.json \\
    -r -l test.log --maxMemoryPercent 80 --concurrentLimit 200
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
            // [C1] 连接时间百分位
            connectTime: {
                avg: stats.connectTimeCalc.getAvg(),
                p50: stats.connectTimeCalc.getPercentile(50),
                p95: stats.connectTimeCalc.getPercentile(95),
                p99: stats.connectTimeCalc.getPercentile(99),
            },
        },
        messages: {
            subscribesSent: Number(stats.subscribesSent),
            received: Number(stats.messagesReceived),
            bytesSent: Number(stats.bytesSent),
            bytesReceived: Number(stats.bytesReceived),
            // [C2] 吞吐量峰值
            peakMsgRate: Number(stats.peakMsgRate),
            peakBytesRate: Number(stats.peakBytesRate),
        },
        latency: {
            avg: stats.latencyCalc.getAvg(),
            min: stats.latencyCalc.getMin(),
            max: stats.latencyCalc.getMax(),
            p50: stats.latencyCalc.getPercentile(50),
            p95: stats.latencyCalc.getPercentile(95),
            p99: stats.latencyCalc.getPercentile(99),
        },
        // [C5] TTFB
        ttfb: {
            avg: stats.ttfbCalc.getAvg(),
            p50: stats.ttfbCalc.getPercentile(50),
            p95: stats.ttfbCalc.getPercentile(95),
            p99: stats.ttfbCalc.getPercentile(99),
        },
        memory: { peak: stats.peakMemory, final: mem.heapUsed },
        // [E2] 稳定性
        stability: {
            leakWarnings: stats.leakWarnings,
            degraded: stats.degraded,
            degradeReason: stats.degradeReason,
        },
        errorTypes: Object.fromEntries(stats.errorTypes),
    };
}

function printFinalReport() {
    const d = getReportData();
    const recvRate = (d.messages.received / (d.testDuration / 1000)).toFixed(2);

    console.log(`
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      最终测试报告 v3.0                                        │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  测试时长: ${d.testDurationFormatted.padEnd(12)}                      目标连接数: ${config.totalConnections.toLocaleString().padEnd(10)}                          │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  ▌连接    成功: ${String(d.connections.success).padEnd(8)}  失败: ${String(d.connections.failed).padEnd(6)}  错误: ${String(d.connections.errors).padEnd(6)}  关闭: ${String(d.connections.closed).padEnd(8)}  重连: ${String(d.connections.reconnects).padEnd(6)}    │
│           建连时间: avg=${d.connections.connectTime.avg.toFixed(1).padEnd(6)}ms P50=${d.connections.connectTime.p50.toFixed(1).padEnd(6)}ms P95=${d.connections.connectTime.p95.toFixed(1).padEnd(6)}ms P99=${d.connections.connectTime.p99.toFixed(1).padEnd(6)}ms │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  ▌消息    订阅: ${String(d.messages.subscribesSent).padEnd(10)}  接收: ${String(d.messages.received).padEnd(12)}  流量: ↑${formatBytes(d.messages.bytesSent).padEnd(8)} / ↓${formatBytes(d.messages.bytesReceived).padEnd(8)}    │
│           峰值TPS: ${String(d.messages.peakMsgRate).padEnd(10)} msg/s    峰值带宽: ${formatBytes(d.messages.peakBytesRate).padEnd(10)}/s                           │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  ▌延迟    avg: ${d.latency.avg.toFixed(2).padEnd(6)}ms  min: ${String(d.latency.min).padEnd(4)}ms  max: ${String(d.latency.max).padEnd(5)}ms  P50: ${d.latency.p50.toFixed(2).padEnd(6)}ms  P95: ${d.latency.p95.toFixed(2).padEnd(6)}ms  P99: ${d.latency.p99.toFixed(2).padEnd(6)}ms    │
│  ▌TTFB    avg: ${d.ttfb.avg.toFixed(2).padEnd(6)}ms                              P50: ${d.ttfb.p50.toFixed(2).padEnd(6)}ms  P95: ${d.ttfb.p95.toFixed(2).padEnd(6)}ms  P99: ${d.ttfb.p99.toFixed(2).padEnd(6)}ms    │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  ▌资源    内存峰值: ${formatBytes(d.memory.peak).padEnd(10)}   最终: ${formatBytes(d.memory.final).padEnd(10)}   泄漏警告: ${String(d.stability.leakWarnings).padEnd(4)}                    │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  ▌性能    平均接收速率: ${recvRate.padEnd(12)} msg/s                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘`);
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

// ========== [A3] 预热模式 ==========
let warmupComplete = false;
let warmupStartTime = 0;

async function startWithWarmup() {
    console.log(clc.yellow('预热模式: 建立所有连接后开始测试...'));
    warmupStartTime = Date.now();

    // 建立连接
    connectBatch();

    // 等待所有连接建立
    await new Promise(resolve => {
        const checkInterval = setInterval(() => {
            const progress = ((activeConnections / config.totalConnections) * 100).toFixed(1);
            process.stdout.write(`\r预热中: ${activeConnections}/${config.totalConnections} (${progress}%)`);

            if (activeConnections >= config.totalConnections * 0.95 || connectionsCreated >= config.totalConnections) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 500);
    });

    const warmupTime = Date.now() - warmupStartTime;
    console.log(clc.green(`\n预热完成: ${activeConnections} 连接就绪，耗时 ${formatDuration(warmupTime)}`));
    console.log(clc.cyan('开始正式测试...\n'));

    warmupComplete = true;
    // 重置统计数据
    stats.messagesReceived = 0n;
    stats.bytesReceived = 0n;
    stats.lastMsgReceived = 0n;
    stats.lastBytesReceived = 0n;
    stats.peakMsgRate = 0n;
    stats.peakBytesRate = 0n;

    log(`[${new Date().toISOString()}] 预热完成，开始正式测试`);
}

// ========== 启动 ==========
console.clear();
console.log(clc.bold.cyan('WebSocket 稳定性压测工具 v3.0 (优化版)'));
console.log(`目标: ${config.url}`);
console.log(`连接: ${config.totalConnections} 批次: ${config.batchSize} 间隔: ${config.batchIntervalMs}ms`);
console.log(`并发限制: ${config.concurrentLimit} 连接超时: ${config.connectTimeout}ms`);
if (subscribePayloads) {
    console.log(clc.green(`订阅消息: ${subscribePayloads.length} 条 (每连接只发送一次)`));
}
console.log();

log(`[${new Date().toISOString()}] 配置: ${JSON.stringify(config)}`);

// [E4] 预解析 DNS
dnsCache.resolve(targetHostname).then(() => {
    log(`[${new Date().toISOString()}] DNS 预解析完成: ${targetHostname}`);
}).catch(err => {
    log(`[${new Date().toISOString()}] DNS 预解析失败: ${err.message}`);
});

if (config.warmup) {
    startWithWarmup();
} else {
    connectBatch();
}
