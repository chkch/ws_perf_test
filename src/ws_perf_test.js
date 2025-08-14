#!/usr/bin/env node
const clc = require('cli-color');
const WebSocket = require('ws');
const fs = require('fs');

let count = 0, failed = 0, errorCount = 0, close = 0, messageReceived = 0;

// 命令行参数
const url = process.argv[2] || 'ws://127.0.0.1:9502';
const totalConnections = parseInt(process.argv[3] || 10000);
const batchSize = parseInt(process.argv[4] || 500);
const batchIntervalMs = parseInt(process.argv[5] || 1000);
let customData = process.argv[6] || false;
let customJSON = null;

// 读取自定义消息
try {
    if (customData) {
        customJSON = JSON.parse(fs.readFileSync(customData, 'utf8'));
    } else {
        customData = false;
    }
} catch {
    console.error(clc.red(`无法解析 ${customData}，将使用默认模式`));
    customData = false;
}

let activeConnections = 0;
let connectionsCreated = 0;

function createConnection() {
    const ws = new WebSocket(url);

    let sendTimer = null;
    let pingTimer = null;

    ws.on('open', () => {
        count++;
        activeConnections++;
        state();

        // 消息发送定时器
        if (!customData) {
            sendTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(Math.floor(Math.random() * 0xFFFFFF).toString());
                }
            }, 1000);
        } else {
            sendTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    if (Array.isArray(customJSON)) {
                        for (const item of customJSON) {
                            ws.send(JSON.stringify(item));
                        }
                    } else {
                        ws.send(JSON.stringify(customJSON));
                    }
                }
            }, 1000);
        }

        // 每 20 秒发送 ping
        pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 20000);
    });

    ws.on('message', () => {
        messageReceived++;
        state();
    });

    ws.on('pong', () => {
        // 心跳响应可统计
    });

    ws.on('error', (err) => {
        errorCount++;
        console.error(clc.red(`[连接错误] ${err.message}`));
        state();
    });

    ws.on('close', () => {
        close++;
        activeConnections--;
        state();
        if (sendTimer) clearInterval(sendTimer);
        if (pingTimer) clearInterval(pingTimer);
    });

    ws.on('unexpected-response', () => {
        failed++;
        state();
    });
}

function connectBatch() {
    const remaining = totalConnections - connectionsCreated;
    if (remaining <= 0) return;

    const currentBatchSize = Math.min(batchSize, remaining);
    for (let i = 0; i < currentBatchSize; i++) {
        createConnection();
        connectionsCreated++;
    }

    if (connectionsCreated < totalConnections) {
        setTimeout(connectBatch, batchIntervalMs);
    }
}

// 状态打印
let lastPrintTime = Date.now();
const printInterval = 1000;
function state() {
    const now = Date.now();
    if (now - lastPrintTime >= printInterval) {
        process.stdout.write(clc.move.top);
        console.debug(
            clc.green('连接成功:') + clc.white(count),
            clc.yellow('连接失败:') + clc.white(failed),
            clc.magenta('连接错误:') + clc.white(errorCount),
            clc.yellow('连接关闭:') + clc.white(close),
            clc.cyan('活跃连接:') + clc.white(activeConnections),
            clc.red('已接收訊息:') + clc.white(messageReceived)
        );
        lastPrintTime = now;
    }
}

// ---------- 异常捕获 ----------
process.on('uncaughtException', (err) => {
    console.error(clc.redBright('\n[未捕获异常]'), err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(clc.redBright('\n[未处理的 Promise 拒绝]'), reason);
    process.exit(1);
});

// ---------- 程序退出事件 ----------
process.on('exit', (code) => {
    console.log(clc.yellow(`\n程序退出，退出码: ${code}`));
    console.log(clc.green('最终统计:'),
        `连接成功=${count}, 连接失败=${failed}, 错误=${errorCount}, 关闭=${close}, 收到消息=${messageReceived}`
    );
});

process.on('SIGINT', () => {
    console.log("\n测试结束，正在关闭所有连接...");
    process.exit(0);
});

// 启动批量连接
connectBatch();