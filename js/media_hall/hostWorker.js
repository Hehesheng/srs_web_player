/**
 * Host-side media plane.
 *
 * Runs in a dedicated worker so File.slice().arrayBuffer() never blocks the
 * player UI.  The server asks for byte ranges with `read` messages; we answer
 * with binary frames.  Control heartbeats are forwarded verbatim.
 */

import { FLAG_ERROR, FLAG_FINAL, decodeControl, encodeFrame } from "./protocol.js";

const CHUNK_SIZE = 64 * 1024;
const BUFFER_HIGH_WATER = 1024 * 1024;
const MAX_PARALLEL_READS = 4;
const FATAL_CLOSE_CODES = new Set([4000, 4001, 4401, 4403, 4404, 4410, 4503]);
const MAX_RECONNECT_ATTEMPTS = 8;

let file = null;
let wsUrl = "";
let token = "";
let ws = null;
let manualClose = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let flowTimer = null;
let activeReads = 0;
const pendingReads = [];
const cancelled = new Set();

self.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    switch (message.type) {
        case "init":
            file = message.file;
            wsUrl = message.wsUrl;
            token = message.token;
            connect();
            break;
        case "state":
        case "seek":
        case "subtitle_select":
            sendControl(message.type, message.payload);
            break;
        case "end":
            sendControl("end", {});
            break;
        case "close":
            shutdown();
            break;
        default:
            break;
    }
};

function post(message) {
    self.postMessage(message);
}

function connect() {
    if (manualClose) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    post({ type: "connecting", attempt: reconnectAttempts });

    let socket;
    try {
        socket = new WebSocket(wsUrl);
    } catch {
        scheduleReconnect();
        return;
    }
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.onopen = () => {
        sendRaw({ type: "auth", role: "host", token });
        startFlow();
    };

    socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = decodeControl(event.data);
        if (!message) return;
        switch (message.type) {
            case "auth_ok":
                reconnectAttempts = 0;
                post({
                    type: "auth_ok",
                    roomCode: message.room_code,
                    room: message.room,
                    media: message.media,
                    members: message.members,
                    host: message.host,
                });
                break;
            case "read":
                enqueueRead(message);
                break;
            case "cancel":
                cancelled.add(Number(message.id));
                break;
            case "room_state":
            case "state":
            case "seek":
            case "resync":
                post({
                    type: "room",
                    data: message,
                    members: message.members,
                });
                break;
            case "error":
                post({ type: "error", code: message.code, message: message.message });
                break;
            default:
                break;
        }
    };

    socket.onclose = (event) => {
        if (ws !== socket) return;
        stopFlow();
        ws = null;
        activeReads = 0;
        pendingReads.length = 0;
        cancelled.clear();
        if (manualClose) {
            post({ type: "closed", code: event.code, fatal: true });
            return;
        }
        if (FATAL_CLOSE_CODES.has(event.code)) {
            post({ type: "closed", code: event.code, reason: event.reason, fatal: true });
            return;
        }
        scheduleReconnect();
    };

    socket.onerror = () => {
        // onclose always follows; reconnect logic lives there.
    };
}

function scheduleReconnect() {
    if (manualClose) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        post({ type: "closed", code: 0, fatal: true, reason: "reconnect exhausted" });
        return;
    }
    reconnectAttempts += 1;
    const delay = Math.min(10000, 500 * 2 ** (reconnectAttempts - 1));
    post({ type: "reconnecting", attempt: reconnectAttempts, delay });
    reconnectTimer = setTimeout(connect, delay);
}

function sendRaw(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

function sendControl(type, payload) {
    if (!payload || typeof payload !== "object") return;
    sendRaw({ type, ...payload });
}

function startFlow() {
    stopFlow();
    flowTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const buffered = ws.bufferedAmount || 0;
        sendRaw({ type: "flow", buffered });
        post({ type: "metrics", buffered });
    }, 500);
}

function stopFlow() {
    if (flowTimer) clearInterval(flowTimer);
    flowTimer = null;
}

function enqueueRead(request) {
    pendingReads.push(request);
    pump();
}

function pump() {
    while (activeReads < MAX_PARALLEL_READS && pendingReads.length) {
        const request = pendingReads.shift();
        activeReads += 1;
        readAndReply(request)
            .catch((error) => sendErrorFrame(request, error))
            .finally(() => {
                activeReads -= 1;
                pump();
            });
    }
}

async function readAndReply(request) {
    const reqId = Number(request.id) >>> 0;
    const gen = Number(request.gen) >>> 0;
    const offset = Math.max(0, Number(request.offset) || 0);
    const length = Math.max(0, Number(request.length) || 0);

    if (!file) throw new Error("no host file selected");
    if (cancelled.delete(reqId)) return;
    if (length <= 0) {
        sendFrame(reqId, gen, 0, FLAG_FINAL, new Uint8Array(0));
        return;
    }

    const end = Math.min(file.size, offset + length);
    if (end <= offset) {
        sendFrame(reqId, gen, 0, FLAG_FINAL, new Uint8Array(0));
        return;
    }

    const buffer = await file.slice(offset, end).arrayBuffer();
    if (cancelled.delete(reqId)) return;

    const bytes = new Uint8Array(buffer);
    let seq = 0;
    for (let cursor = 0; cursor < bytes.byteLength; cursor += CHUNK_SIZE) {
        if (cancelled.delete(reqId)) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        await waitForBuffer();
        if (cancelled.delete(reqId)) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const chunk = bytes.subarray(cursor, Math.min(bytes.byteLength, cursor + CHUNK_SIZE));
        const final = cursor + chunk.byteLength >= bytes.byteLength;
        sendFrame(reqId, gen, seq, final ? FLAG_FINAL : 0, chunk);
        seq = (seq + 1) & 0xffff;
    }
}

function sendFrame(reqId, gen, seq, flags, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(encodeFrame(reqId, gen, seq, flags, payload));
    } catch {
        // The socket is going away; the server will time out and retry.
    }
}

function sendErrorFrame(request, error) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const reqId = Number(request.id) >>> 0;
    const gen = Number(request.gen) >>> 0;
    const message = new TextEncoder().encode(String((error && error.message) || error || "read failed"));
    sendFrame(reqId, gen, 0, FLAG_FINAL | FLAG_ERROR, message);
}

function waitForBuffer() {
    return new Promise((resolve) => {
        const started = Date.now();
        const check = () => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return resolve();
            if ((ws.bufferedAmount || 0) <= BUFFER_HIGH_WATER) return resolve();
            if (Date.now() - started >= 10000) return resolve();
            setTimeout(check, 25);
        };
        check();
    });
}

function shutdown() {
    manualClose = true;
    clearTimeout(reconnectTimer);
    stopFlow();
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: "end" }));
        } catch {
            // ignore
        }
    }
    if (ws) {
        try {
            ws.close(1000, "host closed");
        } catch {
            // ignore
        }
    }
    ws = null;
    post({ type: "closed", code: 1000, fatal: true });
    setTimeout(() => self.close(), 50);
}
