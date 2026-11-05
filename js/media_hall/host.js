/**
 * Host controller: owns the local <video>, heartbeats its timeline and drives
 * the worker that serves byte ranges to the server.
 */

import { websocketUrl } from "./protocol.js";

const HEARTBEAT_PLAYING_MS = 250;
const HEARTBEAT_PAUSED_MS = 1000;

export class HostController {
    constructor({ video, file, session, onStatus, onMembers, onRoomState, onError, onClosed, onMetrics, onProgress }) {
        this.video = video;
        this.file = file;
        this.session = session;
        this.onStatus = onStatus || (() => {});
        this.onMembers = onMembers || (() => {});
        this.onRoomState = onRoomState || (() => {});
        this.onError = onError || (() => {});
        this.onClosed = onClosed || (() => {});
        this.onMetrics = onMetrics || (() => {});
        this.onProgress = onProgress || (() => {});

        this.worker = null;
        this.objectUrl = null;
        this.seq = 0;
        this.waiting = false;
        this.mediaEnded = false;
        this.ready = false;
        this.lastSentAt = 0;
        this.timer = null;
        this.listeners = [];
    }

    start() {
        const video = this.video;
        if (this.file) {
            this.objectUrl = URL.createObjectURL(this.file);
            video.src = this.objectUrl;
        } else {
            // URL rooms are relayed by the server; the host plays the same
            // signed media URL as members so it remains the timing authority.
            video.src = this.session.media_url;
        }
        video.preload = "metadata";
        video.controls = true;
        video.muted = false;

        const listen = (name, handler) => {
            video.addEventListener(name, handler);
            this.listeners.push([name, handler]);
        };

        listen("loadedmetadata", () => {
            this.ready = true;
            this.sendState(false);
        });
        listen("canplay", () => {
            if (this.waiting) {
                this.waiting = false;
                this.sendState(false);
            }
        });
        listen("play", () => {
            this.waiting = false;
            if (this.mediaEnded) {
                this.mediaEnded = false;
                this.seq = (this.seq + 1) >>> 0;
                this.sendState(true);
                return;
            }
            this.sendState(false);
        });
        listen("pause", () => this.sendState(false));
        listen("waiting", () => {
            this.waiting = true;
            this.sendState(false);
        });
        listen("playing", () => {
            this.waiting = false;
            this.sendState(false);
        });
        listen("ratechange", () => this.sendState(false));
        listen("seeking", () => {
            this.waiting = video.readyState < 3;
        });
        listen("seeked", () => {
            this.mediaEnded = false;
            this.waiting = video.readyState < 3;
            this.seq = (this.seq + 1) >>> 0;
            this.sendState(true);
        });
        listen("ended", () => {
            this.mediaEnded = true;
            this.waiting = false;
            this.sendRaw({ type: "end" });
        });
        listen("error", () => {
            const code = video.error ? video.error.code : 0;
            this.onError(`视频加载失败（错误码 ${code}），请确认文件格式可被浏览器播放`);
        });

        this.worker = new Worker(new URL("./hostWorker.js", import.meta.url), { type: "module" });
        this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
        this.worker.onerror = (event) => {
            this.onError(`房主传输线程异常：${event.message || "unknown error"}`);
        };
        this.worker.postMessage({
            type: "init",
            file: this.file,
            wsUrl: websocketUrl(`/hall/ws/${this.session.room_id}`),
            token: this.session.host_token,
        });

        this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_PLAYING_MS);
        this.onProgress({ position: 0, rate: 1, paused: true, waiting: false });
    }

    heartbeat() {
        const video = this.video;
        if (!this.ready) return;
        const playing = !video.paused && !video.ended;
        if (!playing && performance.now() - this.lastSentAt < HEARTBEAT_PAUSED_MS) {
            this.emitProgress();
            return;
        }
        this.sendState(false);
        this.emitProgress();
    }

    emitProgress() {
        const video = this.video;
        this.onProgress({
            position: Number(video.currentTime) || 0,
            rate: Number(video.playbackRate) || 1,
            paused: video.paused || video.ended,
            waiting: this.waiting,
        });
    }

    sendState(isSeek) {
        const video = this.video;
        if (!this.worker || !this.ready) return;
        const position = Number(video.currentTime) || 0;
        const playing = !video.paused && !video.ended;
        const buffering = this.waiting || (playing && video.readyState < 3);
        this.lastSentAt = performance.now();
        this.worker.postMessage({
            type: isSeek ? "seek" : "state",
            payload: {
                seq: this.seq,
                position: Number(position.toFixed(3)),
                rate: Number((Number(video.playbackRate) || 1).toFixed(3)),
                playing,
                buffering,
                duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : 0,
            },
        });
    }

    sendRaw(payload) {
        if (!this.worker) return;
        this.worker.postMessage(payload);
    }

    selectSubtitle(subtitleId, visible = true) {
        this.sendRaw({ type: "subtitle_select", payload: { subtitle_id: subtitleId, visible } });
    }

    // -- media swap ----------------------------------------------------
    suspendMedia() {
        this.sendRaw({ type: "suspend" });
    }

    resumeMedia() {
        this.sendRaw({ type: "resume" });
    }

    /** Swap the locally played file while the room and its socket stay alive. */
    switchFile(file) {
        this.file = file;
        if (this.worker) this.worker.postMessage({ type: "file", file });

        const video = this.video;
        const previousUrl = this.objectUrl;
        this.objectUrl = URL.createObjectURL(file);
        this.ready = false;
        this.waiting = false;
        this.mediaEnded = false;
        this.seq = (this.seq + 1) >>> 0;
        try {
            video.pause();
        } catch {
            // ignore
        }
        video.src = this.objectUrl;
        video.load();
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        this.onProgress({ position: 0, rate: 1, paused: true, waiting: false });
    }

    handleWorkerMessage(message) {
        if (!message || typeof message !== "object") return;
        switch (message.type) {
            case "connecting":
                this.onStatus("connecting");
                break;
            case "auth_ok":
                this.onStatus("connected");
                if (Array.isArray(message.members)) this.onMembers(message.members);
                if (message.room) this.onRoomState(message.room);
                break;
            case "reconnecting":
                this.onStatus("reconnecting", message.attempt);
                break;
            case "metrics":
                this.onMetrics({ buffered: Number(message.buffered) || 0 });
                break;
            case "room":
                if (Array.isArray(message.members)) this.onMembers(message.members);
                if (message.data && message.data.type === "room_state") {
                    this.onRoomState(message.data);
                    if (message.data.ended) this.onStatus("ended");
                }
                break;
            case "error":
                this.onError(message.message || message.code || "房主端发生错误");
                break;
            case "closed":
                this.onStatus("closed");
                this.onClosed({ fatal: Boolean(message.fatal), code: message.code, reason: message.reason });
                break;
            default:
                break;
        }
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;

        for (const [name, handler] of this.listeners) {
            this.video.removeEventListener(name, handler);
        }
        this.listeners = [];

        if (this.worker) {
            this.worker.postMessage({ type: "close" });
            const worker = this.worker;
            this.worker = null;
            setTimeout(() => worker.terminate(), 250);
        }

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
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}
