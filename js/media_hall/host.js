/**
 * Host controller: owns the local <video>, heartbeats its timeline and drives
 * the worker that serves byte ranges to the server.
 */

import { attachHls, detachHls } from "./hls.js";
import { websocketUrl } from "./protocol.js";

const HEARTBEAT_PLAYING_MS = 250;
const HEARTBEAT_PAUSED_MS = 1000;
// How long the position may stand still before we call it a stall.  Long
// enough to ride out a single hiccup, short enough that members stop promptly.
const STALL_CONFIRM_MS = 700;

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
        this.lastPos = 0;
        this.lastAdvanceAt = 0;
        this.mediaEnded = false;
        this.ready = false;
        this.lastSentAt = 0;
        this.timer = null;
        this.listeners = [];
        this.onVisibility = null;
        // Transcoded playback runs on a stream that starts partway through the
        // item, so the element's own clock has to be shifted to get item time.
        this.isHls = false;
        this.timeOffset = 0;
        this.mediaDuration = 0;
        // A position we asked a stream to open at and it has not reached yet.
        this.pendingStart = null;
        this.pendingStartUntil = 0;
        // Whether the room is meant to be playing.  Swapping the source pauses
        // the element, and a restart is only a seek -- reading `video.paused`
        // after one would say the host had stopped and leave the room waiting
        // for a click that is not coming.
        this.playIntent = false;
        // Set around a pause we cause ourselves, so the pause event it fires
        // is not read as the host pressing stop.
        this.swapPause = false;
        this.resumeTried = false;
        // A transcode swap leaves this element with nothing to play for as
        // long as the encoder takes to cut its first segment -- seconds, after
        // a seek.  `ready` is false for that whole window, and going quiet for
        // it is the one thing that must not happen: the room projects a silent
        // host's last position forward, so every member seeks to where the
        // *previous* stream was and then waits for segments the new one is not
        // making.  While this is set we keep reporting the position the room
        // opened at, with `buffering`.
        this.swapping = false;
    }

    /** The element's clock is stream-relative; callers want item time. */
    absoluteTime() {
        const clock = Number(this.video.currentTime) || 0;
        // A restarted stream opens at its first segment and only lands on the
        // room's position once those segments arrive.  Reporting the 0 it
        // shows meanwhile would dip the bar -- and every member's target --
        // back to the item's start for those seconds.
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

    effectiveDuration() {
        if (this.isHls && this.mediaDuration > 0) return this.mediaDuration;
        return Number.isFinite(this.video.duration) ? this.video.duration : 0;
    }

    progressSnapshot(overrides = {}) {
        const video = this.video;
        return {
            position: Number(video.currentTime) || 0,
            absolute: this.absoluteTime(),
            duration: this.effectiveDuration(),
            rate: Number(video.playbackRate) || 1,
            paused: video.paused || video.ended,
            waiting: this.trackAdvance(),
            ...overrides,
        };
    }

    start() {
        const video = this.video;
        if (this.file) {
            this.objectUrl = URL.createObjectURL(this.file);
            video.src = this.objectUrl;
        } else if (this.session.media && this.session.media.playback_mode === "hls") {
            // Attached from the first room state instead: a URL kept from a
            // previous page load may belong to a transcode that has restarted.
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
            // The new stream has something to show, so the room can stop being
            // told this host is mid-swap.
            this.swapping = false;
            this.onLoaded();
            this.sendState(false);
            this.resumeIfWanted();
        });
        listen("canplay", () => {
            if (this.waiting) {
                this.waiting = false;
                this.sendState(false);
            }
            this.resumeIfWanted();
        });
        listen("play", () => {
            this.waiting = false;
            // Playback started, however it was started: from here on a restart
            // means "carry on", not "the host stopped".
            this.playIntent = true;
            if (this.mediaEnded) {
                this.mediaEnded = false;
                this.seq = (this.seq + 1) >>> 0;
                this.sendState(true);
                return;
            }
            this.sendState(false);
        });
        listen("pause", () => {
            if (this.swapPause) this.swapPause = false;
            else this.playIntent = false;
            this.sendState(false);
        });
        listen("waiting", () => {
            this.waiting = true;
            this.sendState(false);
        });
        listen("playing", () => {
            this.waiting = false;
            this.sendState(false);
        });
        listen("ratechange", () => this.sendState(false));
        // Seeking is not buffering: `readyState` dips during any seek, and on
        // iOS it sits at 2 anyway.  The advance tracker decides (see above).
        listen("seeking", () => this.sendState(false));
        listen("seeked", () => {
            this.mediaEnded = false;
            this.seq = (this.seq + 1) >>> 0;
            this.sendState(true);
        });
        listen("ended", () => {
            this.mediaEnded = true;
            this.waiting = false;
            this.playIntent = false;
            this.sendRaw({ type: "end" });
            this.onEnded();
        });
        listen("error", () => {
            const media = video.error;
            if (!media) return;
            // Whatever went wrong, it is not a swap still in flight: leaving
            // this set would keep telling the room to wait for a stream that
            // is never coming.
            this.swapping = false;
            // Swapping the source aborts whatever the old stream was still
            // fetching, and the element reports that as MEDIA_ERR_ABORTED even
            // though the new stream is fine.  A transcode's real failures come
            // through hls.js instead -- passing this on told the host to pick
            // the video again every time they dragged the progress bar.
            if (media.code === 1) return;
            this.onError("视频加载失败", {
                kind: "media",
                code: media.code,
                detail: media.message || "",
            });
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
        this.onProgress(this.progressSnapshot({ paused: true, waiting: false, position: 0 }));
    }

    heartbeat() {
        const video = this.video;
        // A swap is exactly when the room must not be left guessing, and it is
        // the one window where `ready` is false on purpose.
        if (!this.ready && !this.swapping) return;
        const playing = !video.paused && !video.ended;
        if (!playing && performance.now() - this.lastSentAt < HEARTBEAT_PAUSED_MS) {
            this.emitProgress();
            return;
        }
        this.sendState(false);
        this.emitProgress();
    }

    /**
     * Whether this host is actually starved.
     *
     * `readyState < 3` cannot be used for that: iOS/Safari holds a native HLS
     * element at 2 for the whole stream while the picture runs, and a lone
     * `stalled` event does not stop playback either, so both would freeze the
     * room's timeline while nothing is wrong.  The position standing still is
     * the one signal that means the host cannot play right now.
     */
    trackAdvance() {
        const video = this.video;
        const now = performance.now();
        const position = Number(video.currentTime) || 0;
        if (Math.abs(position - this.lastPos) > 0.0005) {
            this.lastPos = position;
            this.lastAdvanceAt = now;
            if (this.waiting) this.waiting = false;
        } else if (!this.lastAdvanceAt) {
            this.lastAdvanceAt = now;
        }
        const playing = !video.paused && !video.ended;
        return playing && now - this.lastAdvanceAt > STALL_CONFIRM_MS;
    }

    emitProgress() {
        this.onProgress(this.progressSnapshot());
    }

    sendState(isSeek) {
        const video = this.video;
        if (!this.worker || (!this.ready && !this.swapping)) return;
        // Stream-relative on purpose: members are watching the same transcode,
        // so they compare against their own element clock.  That clock reads 0
        // while a restarted stream is still opening, and publishing that would
        // pull everyone back to the item's start for those seconds -- so a
        // stream we just re-opened reports the position it was asked to open
        // at instead.
        const position = this.absoluteTime();
        const playing = !video.paused && !video.ended;
        // A swap in flight has no picture here, which is what `buffering`
        // means to the room: hold the position, do not ride it out.
        const buffering = this.swapping || this.trackAdvance();
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
                duration: Number(this.effectiveDuration().toFixed(3)),
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
        this.resetHlsState();
        this.file = file;
        if (this.worker) this.worker.postMessage({ type: "file", file, mediaId });

        const video = this.video;
        const previousUrl = this.objectUrl;
        this.objectUrl = URL.createObjectURL(file);
        this.ready = false;
        this.waiting = false;
        this.mediaEnded = false;
        this.seq = (this.seq + 1) >>> 0;
        this.pauseForSwap();
        video.src = this.objectUrl;
        video.load();
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        this.onProgress(this.progressSnapshot({ paused: true, waiting: false, position: 0 }));
    }

    /** Switch to a server-relayed URL item (url rooms and url playlist items). */
    switchUrl(url) {
        this.resetHlsState();
        this.file = null;
        if (this.worker) this.worker.postMessage({ type: "file", file: null, mediaId: null });

        const video = this.video;
        const previousUrl = this.objectUrl;
        this.objectUrl = null;
        this.ready = false;
        this.waiting = false;
        this.mediaEnded = false;
        this.seq = (this.seq + 1) >>> 0;
        this.pauseForSwap();
        if (url) video.src = url;
        else video.removeAttribute("src");
        video.load();
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        this.onProgress(this.progressSnapshot({ paused: true, waiting: false, position: 0 }));
    }

    /** Switch to a Jellyfin transcode: a whole-item playlist, not a file. */
    switchHls(url, { start = 0, duration = 0, resume = null } = {}) {
        this.resetHlsState();
        this.loadHls(url, { start, duration, resume, restart: true });
    }

    /**
     * Attach a transcoded stream.
     *
     * `start` is where in the item the stream's first segment sits (0 for a
     * Jellyfin transcode, which always hands over the item from its start),
     * and `resume` is where in the item this room wants playback to open --
     * the position a seek or a bitrate change restarts at.
     */
    loadHls(url, { start = 0, duration = 0, restart = false, resume = null } = {}) {
        this.file = null;
        if (this.worker) this.worker.postMessage({ type: "file", file: null, mediaId: null });
        this.isHls = true;
        this.timeOffset = Math.max(0, Number(start) || 0);
        this.mediaDuration = Math.max(0, Number(duration) || 0);
        const wanted = resume === null || resume === undefined
            ? this.timeOffset
            : Math.max(this.timeOffset, Number(resume) || 0);
        this.objectUrl = null;
        this.ready = false;
        this.waiting = true;
        this.mediaEnded = false;
        if (restart) this.seq = (this.seq + 1) >>> 0;
        this.resumeTried = false;
        this.pauseForSwap();
        const startAt = wanted - this.timeOffset;
        // Until the new stream's own segments arrive the element reports 0, so
        // hold the room's position in the meantime (see absoluteTime()).
        this.pendingStart = startAt > 0.5 ? startAt : null;
        this.pendingStartUntil = performance.now() + 20000;
        this.swapping = true;
        attachHls(this.video, url, {
            // Stream time of the room's position: the element's clock runs from
            // the stream's first segment, one item-time offset below the item.
            startAt,
            onError: () => this.onError("转码流已中断，正在重新连接", { kind: "hls" }),
        });
        this.onProgress(this.progressSnapshot({ paused: true, waiting: true, position: 0 }));
        // Tell the room now rather than at the next heartbeat: until this
        // arrives it is still going by the stream this one replaced.
        this.sendState(false);
    }

    /** Drop HLS bookkeeping before playing something else. */
    resetHlsState() {
        if (this.isHls) detachHls(this.video);
        this.isHls = false;
        this.timeOffset = 0;
        this.mediaDuration = 0;
        this.pendingStart = null;
        this.pendingStartUntil = 0;
        this.swapping = false;
    }

    /** The transcode advanced the stream start (a seek); keep item time right. */
    setHlsStart(start) {
        if (!this.isHls) return;
        this.timeOffset = Math.max(0, Number(start) || 0);
        this.pendingStart = null;
        this.pendingStartUntil = 0;
    }

    /** Drop the current media when the playlist becomes empty. */
    clearMedia() {
        this.resetHlsState();
        this.file = null;
        if (this.worker) this.worker.postMessage({ type: "file", file: null, mediaId: null });

        const video = this.video;
        const previousUrl = this.objectUrl;
        this.objectUrl = null;
        this.ready = false;
        this.waiting = false;
        this.mediaEnded = false;
        this.playIntent = false;
        this.pauseForSwap();
        video.removeAttribute("src");
        try {
            video.load();
        } catch {
            // ignore
        }
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        this.onProgress(this.progressSnapshot({ paused: true, waiting: false, position: 0 }));
    }

    play() {
        const video = this.video;
        if (!video.getAttribute("src")) return;
        this.playIntent = true;
        let promise;
        try {
            promise = video.play();
        } catch (error) {
            this.playFailed(error);
            return;
        }
        if (promise && typeof promise.catch === "function") {
            promise.catch((error) => this.playFailed(error));
        }
    }

    /** Is the room meant to be playing right now? */
    wantsPlayback() {
        return this.playIntent && !this.mediaEnded;
    }

    /**
     * A swap aborts a `play()` that was still pending, which arrives here as
     * AbortError.  Only a policy block is worth a message.
     */
    playFailed(error) {
        if (error && error.name === "AbortError") return;
        this.playIntent = false;
        this.onError("浏览器阻止了自动播放，请手动点击播放");
    }

    /** Pause the element without it reading as "the host stopped playing". */
    pauseForSwap() {
        const video = this.video;
        if (video.paused) return;
        this.swapPause = true;
        try {
            video.pause();
        } catch {
            this.swapPause = false;
        }
    }

    /**
     * Carry on once a restarted stream has data.
     *
     * The `play()` that follows a restart often lands before the new stream
     * can play, and comes back as an abort; this is the second chance, so a
     * seek does not leave the host sitting on a still picture.
     */
    resumeIfWanted() {
        if (!this.wantsPlayback() || this.resumeTried) return;
        if (!this.video.paused) return;
        this.resumeTried = true;
        this.play();
    }

    handleWorkerMessage(message) {
        if (!message || typeof message !== "object") return;
        switch (message.type) {
            case "connecting":
                this.onStatus("connecting");
                break;
            case "auth_ok":
                this.onStatus("connected");
                if (Array.isArray(message.members)) {
                    this.onMembers(message.members, message.room && message.room.host_name);
                }
                if (message.room) this.onRoomState(message.room);
                break;
            case "reconnecting":
                this.onStatus("reconnecting", message.attempt);
                break;
            case "metrics":
                this.onMetrics({ buffered: Number(message.buffered) || 0 });
                break;
            case "room":
                if (Array.isArray(message.members)) {
                    this.onMembers(message.members, message.data && message.data.host_name);
                }
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

        this.playIntent = false;
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
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}
