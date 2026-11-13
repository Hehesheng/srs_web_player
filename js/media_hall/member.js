/**
 * Member controller: native <video> playback via HTTP Range relay, a websocket
 * for the host timeline, and local sync corrections.  Members are deliberately
 * read-only: seeking, pausing and rate changes are rejected/hidden.
 */

import { attachHls, detachHls } from "./hls.js";
import { websocketUrl } from "./protocol.js";
import { SyncController } from "./sync.js";

const MAX_RECONNECT_ATTEMPTS = 8;
const AUTH_TIMEOUT_MS = 10000;
// How long the restarts from one drag may keep arriving before the member
// opens the stream.  Short enough that the picture follows a single seek
// immediately, long enough to ride out a burst.
const RESTART_SETTLE_MS = 500;

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
    constructor({ video, session, correction, seekAt, rateCorrection, onOverlay, onRoomState, onHostState, onMembers, onConnected, onDisconnected, onError, onStats, onEnded, onTokenInvalid, onMediaChanged }) {
        this.video = video;
        this.session = session;
        // Left unnormalised on purpose: the sync controller is the one place
        // that decides what "unset" means (`correction !== false`), which also
        // makes this the member's live setting -- `setPolicy` is how the room's
        // 纠偏 control reaches it.
        this.correction = correction;
        this.seekAt = seekAt;
        this.rateCorrection = rateCorrection;
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
        // Transcoded playback: the element's clock starts where the transcode
        // starts, so item time needs an offset.  The epoch tells us when the
        // host restarted the transcode after seeking.
        this.isHls = false;
        this.timeOffset = 0;
        this.mediaDuration = 0;
        this.mediaEpoch = null;
        // A position a restarted stream was asked to open at and has not
        // reached yet; until it does the element still reports 0 (see
        // itemTime()).
        this.pendingStart = null;
        this.pendingStartUntil = 0;
        // How many times the engine was opened in this session, and why: each
        // reopen is a fresh buffer and a visible hitch.  A reopen with no
        // reason attached is one we asked for -- a host seek, a media change --
        // where the ones that carry one are the engine failing on its own.
        this.engineEvents = { attach: 0, native: 0, network: 0, repair: 0, fallback: 0, giveup: 0 };

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
        // A drag reaches the room as a burst of restarts, each with its own
        // epoch.  Following them one by one re-opens the engine for streams
        // that are already gone; this waits for the burst to stop instead.
        this.restartTimer = null;
    }

    start() {
        const video = this.video;
        if (this.session.media_url && this.session.media && this.session.media.playback_mode === "hls") {
            // Attached from the first room state: a URL kept from an earlier
            // page load may belong to a transcode that has since restarted.
        } else if (this.session.media_url) {
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
            correction: this.correction,
            seekAt: this.seekAt,
            rateCorrection: this.rateCorrection,
            send: (payload) => this.send(payload),
            onStats: (stats) => {
                stats.engine = this.engineEvents;
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
        if (Array.isArray(room.members)) this.onMembers(room.members, room.host_name);
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
            this.mediaEpoch = null;
            if (previousId !== null || this.video.getAttribute("src")) this.clearMedia();
            return;
        }
        this.mediaId = media.media_id;
        if (room.media_url) this.session.media_url = room.media_url;
        if (room.media_start !== undefined) this.session.media_start = room.media_start;
        if (room.media_resume !== undefined) this.session.media_resume = room.media_resume;
        this.session.media = media;

        const epoch = Number(room.media_epoch) || 0;
        const firstRoom = this.mediaEpoch === null;
        const restarted = !firstRoom && epoch !== this.mediaEpoch;
        this.mediaEpoch = epoch;

        if (firstRoom && media.playback_mode === "hls") {
            // Nothing is attached yet, and the room's URL is the only current
            // one, so this is where the player joins the stream.
            this.switchMedia();
            this.onMediaChanged(media);
            return;
        }
        if (previousId === null) {
            // The player already loaded this source in start(); only an empty
            // room that just received its first item needs a switch here.
            if (!this.video.getAttribute("src") && !this.isHls) this.switchMedia();
            else this.applyHlsTiming();
            return;
        }
        if (previousId === media.media_id) {
            // The host restarted the transcoder -- a seek, a bitrate change or
            // a subtitle change.  It is the same item, so this is not a media
            // change: saying it was told every viewer the host had switched
            // video whenever the progress bar moved.
            if (restarted && media.playback_mode === "hls") this.followRestart();
            else this.applyHlsTiming();
            return;
        }
        this.cancelRestart();
        this.switchMedia();
        this.onMediaChanged(media);
    }

    /**
     * Re-open the stream once the restarts stop arriving.
     *
     * Dragging the host's progress bar restarts the transcode several times in
     * a row; only the last of those streams carries the picture the room ends
     * up on.  Opening each one in turn spends the whole drag tearing buffers
     * down, and what a viewer sees is the wait getting longer the more they
     * drag.
     */
    followRestart() {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.ended || this.closedByUser) return;
            const media = this.session.media;
            if (!media || media.playback_mode !== "hls") return;
            this.switchMedia();
        }, RESTART_SETTLE_MS);
    }

    cancelRestart() {
        if (!this.restartTimer) return;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
    }

    /** Keep the item-time offset in step with whatever the room reports. */
    applyHlsTiming() {
        const media = this.session.media;
        if (!media || media.playback_mode !== "hls") return;
        this.mediaDuration = Math.max(0, Number(media.duration) || 0);
        this.timeOffset = Math.max(0, Number(this.session.media_start) || 0);
    }

    /** Where this viewer is in the item; the element's clock is stream time. */
    itemTime() {
        const clock = Number(this.video.currentTime) || 0;
        // A stream we just re-opened reports 0 until its segments arrive; the
        // bar would dip to the item's start for those seconds.
        if (this.pendingStart !== null) {
            // Done once the element has actually landed there; until then the
            // clock reads either the old stream's tail or the new one's zero.
            if (Math.abs(clock - this.pendingStart) <= 1 || performance.now() > this.pendingStartUntil) {
                this.pendingStart = null;
            } else {
                return this.timeOffset + this.pendingStart;
            }
        }
        return this.timeOffset + clock;
    }

    /** How far into the item this element has data, in item time. */
    bufferedTime() {
        const ranges = this.video.buffered;
        if (!ranges || !ranges.length) return 0;
        return this.timeOffset + (Number(ranges.end(ranges.length - 1)) || 0);
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
        this.cancelRestart();
        if (this.sync) this.sync.resetForMedia();
        try {
            video.pause();
        } catch {
            // ignore
        }
        if (this.session.media && this.session.media.playback_mode === "hls") {
            this.attachHlsStream();
        } else {
            this.resetHlsState();
            video.src = this.session.media_url;
            video.load();
        }
        this.onOverlay("media", null, null, null);
    }

    /** Play the room's shared transcode; the element clock is stream-relative. */
    attachHlsStream() {
        const media = this.session.media || {};
        this.isHls = true;
        this.mediaDuration = Math.max(0, Number(media.duration) || 0);
        this.timeOffset = Math.max(0, Number(this.session.media_start) || 0);
        // Open where the room restarted the stream.  The clock controller then
        // pulls this element onto the host's own position within a second, so
        // this only has to be close, not exact.
        const resume = Number(this.session.media_resume);
        const startAt = Number.isFinite(resume) ? resume - this.timeOffset : 0;
        this.pendingStart = startAt > 0.5 ? startAt : null;
        this.pendingStartUntil = performance.now() + 20000;
        attachHls(this.video, this.session.media_url, {
            startAt,
            onEvent: (what) => {
                if (this.engineEvents[what] != null) this.engineEvents[what] += 1;
            },
            onError: () => {
                // The stream we are on was replaced while we were still
                // waiting for the room to settle: the next one is coming, so
                // this is not a failure to report.
                if (this.restartTimer) return;
                this.onOverlay("media", "转码流已中断", "重试", () => this.retrySource());
                this.onError("转码流出错，请点击重试");
            },
        });
    }

    resetHlsState() {
        if (this.isHls) detachHls(this.video);
        this.isHls = false;
        this.timeOffset = 0;
        this.mediaDuration = 0;
        this.pendingStart = null;
        this.pendingStartUntil = 0;
    }

    clearMedia() {
        this.mediaRetryCount = 0;
        clearTimeout(this.mediaRetryTimer);
        this.mediaRetryTimer = null;
        this.cancelRestart();
        if (this.sync) this.sync.resetForMedia();
        try {
            this.video.pause();
        } catch {
            // ignore
        }
        this.resetHlsState();
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
        if (Array.isArray(payload.members)) this.onMembers(payload.members, payload.host_name);
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
        // MEDIA_ERR_ABORTED is what the element says when we replace the source
        // under it: the fetch we just cancelled, not a broken stream.  A
        // restart makes this fire for every viewer, and answering it with a
        // retry prompt is noise.
        if (code === 1) return;
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
        const reason = video.error && video.error.message ? video.error.message : "";
        if (code === 4 && /NO_SUPPORTED_STREAMS/i.test(reason)) {
            // The bytes arrived but nothing inside can be decoded; retrying
            // cannot help, so point at the cause instead.
            this.onOverlay(
                "media",
                "这个视频的编码无法解码（常见是 H.265/HEVC 视频或 AC3/DTS 音轨），可以请房主转成 MP4（H.264 + AAC）后再播放",
                null,
                null
            );
            this.onError("视频编码不受支持（错误码 4）");
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
        if (this.isHls) {
            if (this.sync) this.sync.resetForMedia();
            this.attachHlsStream();
            this.onOverlay("media", null, null, null);
        } else {
            video.removeAttribute("src");
            video.load();
            video.src = source;
            video.load();
            this.onOverlay("media", null, null, null);
        }
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

    /** The member's own 纠偏 setting, applied without leaving the room. */
    setPolicy(policy) {
        if (!policy) return;
        if (policy.correction !== undefined) this.correction = policy.correction;
        if (policy.seekAt !== undefined) this.seekAt = policy.seekAt;
        if (policy.rateCorrection !== undefined) this.rateCorrection = policy.rateCorrection;
        if (this.sync) this.sync.setPolicy(policy);
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
        this.resetHlsState();
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
            // Up and down are left alone: they adjust this viewer's own volume
            // and cannot disturb the room.
            const blocked = [
                " ", "Spacebar", "ArrowLeft", "ArrowRight",
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
        this.resetHlsState();
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
        this.cancelRestart();
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
