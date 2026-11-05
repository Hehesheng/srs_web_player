/**
 * Member controller: native <video> playback via HTTP Range relay, a websocket
 * for the host timeline, and local sync corrections.  Members are deliberately
 * read-only: seeking, pausing and rate changes are rejected/hidden.
 */

import { websocketUrl } from "./protocol.js";
import { SyncController } from "./sync.js";

const MAX_RECONNECT_ATTEMPTS = 8;
const AUTH_TIMEOUT_MS = 10000;

const FATAL_CLOSE = new Map([
    [4000, "房间已结束"],
    [4001, "房间已超时关闭"],
    [4401, "身份校验失败，请重新加入"],
    [4403, "身份校验失败，请重新加入"],
    [4404, "房间不存在或已结束"],
    [4410, "房间已结束"],
    [4503, "媒体厅暂时不可用"],
]);

export class MemberController {
    constructor({ video, session, onOverlay, onRoomState, onHostState, onMembers, onConnected, onDisconnected, onError, onStats, onEnded, onTokenInvalid, onMediaChanged }) {
        this.video = video;
        this.session = session;
        this.onOverlay = onOverlay || (() => {});
        this.onRoomState = onRoomState || (() => {});
        this.onHostState = onHostState || (() => {});
        this.onMembers = onMembers || (() => {});
        this.onConnected = onConnected || (() => {});
        this.onDisconnected = onDisconnected || (() => {});
        this.onError = onError || (() => {});
        this.onStats = onStats || (() => {});
        this.onEnded = onEnded || (() => {});
        this.onTokenInvalid = onTokenInvalid || (() => {});
        this.onMediaChanged = onMediaChanged || (() => {});
        this.mediaId = session && session.media && session.media.media_id ? session.media.media_id : null;

        this.ws = null;
        this.sync = null;
        this.authenticated = false;
        this.closedByUser = false;
        this.ended = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.authTimer = null;
        this.statusTimer = null;
        this.lastStats = null;
        this.keyHandler = null;
        this.mediaErrorHandler = null;
        this.mediaPlayHandler = null;
        this.mediaRetryCount = 0;
        this.mediaRetryTimer = null;
    }

    start() {
        const video = this.video;
        if (this.session.media_url) {
            video.src = this.session.media_url;
        } else {
            // The room exists but the host has not picked anything yet.
            video.removeAttribute("src");
            this.onOverlay("media", "等待房主添加内容…", null, null);
        }
        video.preload = "auto";
        video.controls = false;
        video.muted = false;
        video.volume = 1;
        video.disablePictureInPicture = true;
        video.playsInline = true;
        this.mediaErrorHandler = () => this.handleMediaError();
        video.addEventListener("error", this.mediaErrorHandler);
        // Once playback is healthy again, later errors get their own retries.
        this.mediaPlayHandler = () => {
            this.mediaRetryCount = 0;
        };
        video.addEventListener("playing", this.mediaPlayHandler);

        this.sync = new SyncController({
            video,
            send: (payload) => this.send(payload),
            onStats: (stats) => {
                this.lastStats = stats;
                this.onStats(stats);
            },
            onOverlay: (key, text) => {
                this.onOverlay(key, text, null, null);
            },
            onPlayBlocked: () => {
                this.onOverlay(
                    "blocked",
                    "浏览器阻止了自动播放",
                    "点击播放",
                    () => this.resumeFromGesture()
                );
            },
        });

        this.installKeyGuard();
        this.installMediaSession();
        this.connect();

        this.statusTimer = setInterval(() => {
            if (!this.authenticated || !this.lastStats) return;
            this.send({
                type: "status",
                position: Number(video.currentTime.toFixed(3)),
                buffering: this.lastStats.buffering,
                rtt: Math.round(this.lastStats.rtt),
                jitter: Math.round(this.sync.jitter || 0),
            });
        }, 3000);
    }

    // -- websocket -----------------------------------------------------
    connect() {
        if (this.closedByUser || this.ended) return;
        this.closeSocket();
        this.authenticated = false;
        this.onOverlay("connecting", "正在连接房间…", null, null);

        let socket;
        try {
            socket = new WebSocket(websocketUrl(`/hall/ws/${this.session.room_id}`));
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = socket;
        this.authTimer = setTimeout(() => {
            if (!this.authenticated && this.ws === socket) {
                try {
                    socket.close();
                } catch {
                    // ignore
                }
            }
        }, AUTH_TIMEOUT_MS);

        socket.onopen = () => {
            this.sendRaw({ type: "auth", role: "member", token: this.session.member_token });
        };
        socket.onmessage = (event) => {
            if (typeof event.data !== "string") return;
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            this.handleMessage(message);
        };
        socket.onclose = (event) => {
            if (this.ws !== socket) return;
            clearTimeout(this.authTimer);
            this.authenticated = false;
            this.ws = null;
            this.handleSocketClose(event);
        };
        socket.onerror = () => {
            // onclose follows
        };
    }

    handleMessage(message) {
        if (!message || typeof message !== "object") return;
        switch (message.type) {
            case "auth_ok": {
                this.authenticated = true;
                this.reconnectAttempts = 0;
                clearTimeout(this.authTimer);
                this.onOverlay("connecting", null, null, null);
                this.onConnected();
                if (this.sync && !this.sync.running) this.sync.start();
                if (this.sync) this.sync.seedServerTime(message.server_ts);
                this.handleRoom(message.room, true);
                break;
            }
            case "room_state":
                this.handleRoom(message, false);
                break;
            case "state":
            case "seek":
            case "resync":
                this.handleHostEvent(message, message.type);
                break;
            case "pong":
                if (this.sync) this.sync.onPong(message);
                break;
            case "error":
                if (message.code === "MEMBER_READONLY" || message.code === "BAD_MESSAGE") break;
                this.onError(message.message || message.code || "播放服务返回错误");
                break;
            default:
                break;
        }
    }

    handleRoom(room, initial) {
        if (!room) return;
        if (room.name) this.session.room_name = room.name;
        this.applyMedia(room);
        this.onRoomState(room, initial);
        if (Array.isArray(room.members)) this.onMembers(room.members);
        if (room.ended) {
            this.handleEnded();
            return;
        }
        const host = room.host || {};
        if (this.sync) this.sync.setHost(host);
        this.onHostState(host, "room");
        if (host.online === false) {
            this.onOverlay("offline", "房主已离线，等待重连…（持续离线将结束房间）", null, null);
        } else {
            this.onOverlay("offline", null, null, null);
        }
    }

    applyMedia(room) {
        const media = room.media && room.media.media_id ? room.media : null;
        const previousId = this.mediaId;
        if (!media) {
            this.mediaId = null;
            this.session.media = null;
            this.session.media_url = null;
            if (previousId !== null || this.video.getAttribute("src")) this.clearMedia();
            return;
        }
        this.mediaId = media.media_id;
        if (room.media_url) this.session.media_url = room.media_url;
        this.session.media = media;
        if (previousId === null) {
            // The player already loaded this source in start(); only an empty
            // room that just received its first item needs a switch here.
            if (!this.video.getAttribute("src")) this.switchMedia();
            return;
        }
        if (previousId === media.media_id) return;
        this.switchMedia();
        this.onMediaChanged(media);
    }

    switchMedia() {
        const video = this.video;
        if (!this.session.media_url) {
            this.clearMedia();
            return;
        }
        this.mediaRetryCount = 0;
        clearTimeout(this.mediaRetryTimer);
        this.mediaRetryTimer = null;
        if (this.sync) this.sync.resetForMedia();
        try {
            video.pause();
        } catch {
            // ignore
        }
        video.src = this.session.media_url;
        video.load();
        this.onOverlay("media", null, null, null);
    }

    clearMedia() {
        this.mediaRetryCount = 0;
        clearTimeout(this.mediaRetryTimer);
        this.mediaRetryTimer = null;
        if (this.sync) this.sync.resetForMedia();
        try {
            this.video.pause();
        } catch {
            // ignore
        }
        this.video.removeAttribute("src");
        try {
            this.video.load();
        } catch {
            // ignore
        }
        this.onOverlay("media", "等待房主添加内容…", null, null);
    }

    handleHostEvent(payload, event) {
        const host = payload.host;
        if (!host) return;
        if (this.sync) {
            this.sync.setHost(host);
            if (event === "seek" || event === "resync") this.sync.followNow(true);
        }
        this.onHostState(host, event);
        if (Array.isArray(payload.members)) this.onMembers(payload.members);
        if (host.online === false) {
            this.onOverlay("offline", "房主已离线，等待重连…（持续离线将结束房间）", null, null);
        } else {
            this.onOverlay("offline", null, null, null);
        }
    }

    handleSocketClose(event) {
        if (this.closedByUser || this.ended) return;
        const code = Number(event.code) || 0;
        if (FATAL_CLOSE.has(code)) {
            if (code === 4000 || code === 4410) {
                this.handleEnded();
                return;
            }
            const message = FATAL_CLOSE.get(code);
            this.stopPlayback();
            this.onOverlay("fatal", message, "返回首页", () => {
                window.location.href = "media_hall.html";
            });
            this.onDisconnected(message, true);
            if (code === 4401 || code === 4403) this.onTokenInvalid();
            return;
        }
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.stopPlayback();
            this.onOverlay("fatal", "与房间的连接已断开", "重新加载", () => window.location.reload());
            this.onDisconnected("连接已断开", true);
            return;
        }
        this.reconnectAttempts += 1;
        const delay = Math.min(10000, 800 * 2 ** (this.reconnectAttempts - 1));
        this.onOverlay("connecting", `重新连接中…（${this.reconnectAttempts}）`, null, null);
        this.onDisconnected("连接中断，正在重连", false);
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    scheduleReconnect() {
        this.handleSocketClose({ code: 1006 });
    }

    send(payload) {
        if (!this.authenticated) return;
        this.sendRaw(payload);
    }

    sendRaw(payload) {
        const socket = this.ws;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        try {
            socket.send(JSON.stringify(payload));
        } catch {
            // socket is closing
        }
    }

    closeSocket() {
        clearTimeout(this.authTimer);
        const socket = this.ws;
        this.ws = null;
        if (socket) {
            try {
                socket.close();
            } catch {
                // ignore
            }
        }
    }

    // -- media ---------------------------------------------------------
    handleMediaError() {
        const video = this.video;
        const code = video.error ? video.error.code : 0;
        if (!video.getAttribute("src")) return;
        if (this.ended || this.closedByUser) return;
        // A switch can race the host's generation bump and fail one request;
        // retry quietly a couple of times before telling the user.
        if (this.mediaRetryCount < 2) {
            this.mediaRetryCount += 1;
            this.onOverlay("media", "视频加载失败，正在重试…", null, null);
            clearTimeout(this.mediaRetryTimer);
            this.mediaRetryTimer = setTimeout(
                () => this.retrySource(),
                600 * this.mediaRetryCount
            );
            return;
        }
        this.onOverlay(
            "media",
            "视频加载失败，可能是房主离线或网络中断",
            "重试",
            () => this.retrySource()
        );
        this.onError(`媒体加载失败（错误码 ${code}）`);
    }

    retrySource() {
        const video = this.video;
        const source = this.session.media_url;
        video.removeAttribute("src");
        video.load();
        video.src = source;
        video.load();
        this.onOverlay("media", null, null, null);
        if (this.sync && this.sync.host) {
            this.sync.pendingInitialSeek = true;
            if (this.sync.shouldPlay()) {
                this.sync.playSafe();
            }
        }
    }

    correctNow() {
        if (!this.sync) return false;
        return this.sync.correctNow();
    }

    resumeFromGesture() {
        if (!this.sync) return Promise.resolve(false);
        return this.sync.retryPlay().then((ok) => {
            if (ok) this.onOverlay("blocked", null, null, null);
            return ok;
        });
    }

    stopPlayback() {
        clearInterval(this.statusTimer);
        if (this.sync) this.sync.destroy();
        try {
            this.video.pause();
        } catch {
            // ignore
        }
    }

    handleEnded() {
        if (this.ended) return;
        this.ended = true;
        this.stopPlayback();
        this.onOverlay("ended", "房间已结束", "返回首页", () => {
            window.location.href = "media_hall.html";
        });
        this.onEnded();
    }

    installKeyGuard() {
        this.keyHandler = (event) => {
            const target = event.target;
            if (target && target.closest && target.closest("input, textarea, select, button, a")) return;
            const blocked = [
                " ", "Spacebar", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
                "Home", "End", "PageUp", "PageDown",
                "j", "J", "l", "L", ",", ".", "<", ">",
            ];
            if (blocked.includes(event.key) || /^[0-9]$/.test(event.key)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        document.addEventListener("keydown", this.keyHandler, true);
    }

    installMediaSession() {
        if (!("mediaSession" in navigator)) return;
        const session = navigator.mediaSession;
        const noop = () => {};
        const handlers = {
            play: noop,
            pause: noop,
            stop: noop,
            seekbackward: noop,
            seekforward: noop,
            seekto: noop,
            previoustrack: noop,
            nexttrack: noop,
        };
        for (const [action, handler] of Object.entries(handlers)) {
            try {
                session.setActionHandler(action, handler);
            } catch {
                // action unsupported
            }
        }
        try {
            session.metadata = new MediaMetadata({
                title: this.session.room_name || "媒体播放厅",
                artist: "SRS 媒体厅",
            });
        } catch {
            // metadata unsupported
        }
    }

    destroy() {
        this.closedByUser = true;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.authTimer);
        clearInterval(this.statusTimer);
        this.closeSocket();
        if (this.sync) {
            this.sync.destroy();
            this.sync = null;
        }
        clearTimeout(this.mediaRetryTimer);
        this.mediaRetryTimer = null;
        if (this.mediaErrorHandler) {
            this.video.removeEventListener("error", this.mediaErrorHandler);
            this.mediaErrorHandler = null;
        }
        if (this.mediaPlayHandler) {
            this.video.removeEventListener("playing", this.mediaPlayHandler);
            this.mediaPlayHandler = null;
        }
        if (this.keyHandler) {
            document.removeEventListener("keydown", this.keyHandler, true);
            this.keyHandler = null;
        }
        if ("mediaSession" in navigator) {
            for (const action of ["play", "pause", "stop", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"]) {
                try {
                    navigator.mediaSession.setActionHandler(action, null);
                } catch {
                    // ignore
                }
            }
        }
    }
}
