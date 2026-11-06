/**
 * Host controller: owns the local <video>, heartbeats its timeline and drives
 * the worker that serves byte ranges to the server.
 */

import { websocketUrl } from "./protocol.js";

const HEARTBEAT_PLAYING_MS = 250;
const HEARTBEAT_PAUSED_MS = 1000;

export class HostController {
    constructor({ video, file, session, onStatus, onMembers, onRoomState, onError, onClosed, onMetrics, onProgress, onEnded, onLoaded }) {
        this.video = video;
        this.file = file;
        this.session = session;
        this.onLoaded = onLoaded || (() => {});
        this.onStatus = onStatus || (() => {});
        this.onMembers = onMembers || (() => {});
        this.onRoomState = onRoomState || (() => {});
        this.onError = onError || (() => {});
        this.onClosed = onClosed || (() => {});
        this.onMetrics = onMetrics || (() => {});
        this.onProgress = onProgress || (() => {});
        this.onEnded = onEnded || (() => {});

        this.worker = null;
        this.objectUrl = null;
        this.seq = 0;
        this.waiting = false;
        this.mediaEnded = false;
        this.ready = false;
        this.lastSentAt = 0;
        this.timer = null;
        this.listeners = [];
        this.onVisibility = null;
    }

    start() {
        const video = this.video;
        if (this.file) {
            this.objectUrl = URL.createObjectURL(this.file);
            video.src = this.objectUrl;
        } else if (this.session.media_url) {
            // URL rooms are relayed by the server; the host plays the same
            // signed media URL as members so it remains the timing authority.
            video.src = this.session.media_url;
        }
        // With an empty playlist there is nothing to load yet; the worker still
        // connects so the room exists and members can wait for the first item.
        video.preload = "metadata";
        // The host shares the member control bar, so the native one stays off.
        video.controls = false;
        video.muted = false;

        const listen = (name, handler) => {
            video.addEventListener(name, handler);
            this.listeners.push([name, handler]);
        };

        listen("loadedmetadata", () => {
            this.ready = true;
            this.onLoaded();
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
            this.onEnded();
        });
        listen("error", () => {
            const code = video.error ? video.error.code : 0;
            const detail = video.error && video.error.message ? video.error.message : "";
            this.onError("视频加载失败", { kind: "media", code, detail });
        });

        this.worker = new Worker(new URL("./hostWorker.js", import.meta.url), { type: "module" });
        this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
        this.worker.onerror = (event) => {
            this.onError(`房主传输线程异常：${event.message || "unknown error"}`);
        };
        this.worker.postMessage({
            type: "init",
            file: this.file,
            mediaId: this.session.media ? this.session.media.media_id : null,
            wsUrl: websocketUrl(`/hall/ws/${this.session.room_id}`),
            token: this.session.host_token,
        });

        // Hidden tabs throttle timers, so tell the server immediately that the
        // host is still playing and let it keep projecting while we are away.
        this.onVisibility = () => {
            if (!this.worker) return;
            this.sendState(false);
            this.emitProgress();
        };
        document.addEventListener("visibilitychange", this.onVisibility);

        this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_PLAYING_MS);
        this.onProgress({ position: 0, rate: Number(video.playbackRate) || 1, paused: true, waiting: false });
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
                background: document.visibilityState === "hidden",
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
    /** Swap the locally played file while the room and its socket stay alive. */
    switchFile(file, mediaId = null) {
        this.file = file;
        if (this.worker) this.worker.postMessage({ type: "file", file, mediaId });

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
        this.onProgress({ position: 0, rate: Number(video.playbackRate) || 1, paused: true, waiting: false });
    }

    /** Switch to a server-relayed URL item (url rooms and url playlist items). */
    switchUrl(url) {
        this.file = null;
        if (this.worker) this.worker.postMessage({ type: "file", file: null, mediaId: null });

        const video = this.video;
        const previousUrl = this.objectUrl;
        this.objectUrl = null;
        this.ready = false;
        this.waiting = false;
        this.mediaEnded = false;
        this.seq = (this.seq + 1) >>> 0;
        try {
            video.pause();
        } catch {
            // ignore
        }
        if (url) video.src = url;
        else video.removeAttribute("src");
        video.load();
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        this.onProgress({ position: 0, rate: Number(video.playbackRate) || 1, paused: true, waiting: false });
    }

    /** Drop the current media when the playlist becomes empty. */
    clearMedia() {
        this.file = null;
        if (this.worker) this.worker.postMessage({ type: "file", file: null, mediaId: null });

        const video = this.video;
        const previousUrl = this.objectUrl;
        this.objectUrl = null;
        this.ready = false;
        this.waiting = false;
        this.mediaEnded = false;
        try {
            video.pause();
        } catch {
            // ignore
        }
        video.removeAttribute("src");
        try {
            video.load();
        } catch {
            // ignore
        }
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        this.onProgress({ position: 0, rate: Number(video.playbackRate) || 1, paused: true, waiting: false });
    }

    play() {
        const video = this.video;
        if (!video.getAttribute("src")) return;
        let promise;
        try {
            promise = video.play();
        } catch {
            this.onError("浏览器阻止了自动播放，请手动点击播放");
            return;
        }
        if (promise && typeof promise.catch === "function") {
            promise.catch(() => this.onError("浏览器阻止了自动播放，请手动点击播放"));
        }
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
        if (this.onVisibility) {
            document.removeEventListener("visibilitychange", this.onVisibility);
            this.onVisibility = null;
        }

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
