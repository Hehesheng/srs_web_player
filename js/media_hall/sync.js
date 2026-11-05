/**
 * Member clock + drift controller.
 *
 * The host publishes a server-timestamped timeline.  Every member estimates its
 * clock offset with NTP-style pings, then rides a small PLL:
 *
 *   - |drift| < 0.5s   : play at host rate
 *   - 0.5s .. 3s       : gently correct within +/-10% of host rate
 *   - 3s .. 8s         : hard seek after the drift persists for 1s
 *   - > 8s             : hard seek immediately
 *
 * Members always stay D seconds behind the host, where D grows when the local
 * network stalls and shrinks slowly during long stable periods.
 */

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

export class SyncController {
    constructor({ video, send, onStats, onOverlay, onPlayBlocked }) {
        this.video = video;
        this.send = send;
        this.onStats = onStats || (() => {});
        this.onOverlay = onOverlay || (() => {});
        this.onPlayBlocked = onPlayBlocked || (() => {});

        this.host = null;
        this.offset = 0;
        this.offsetValid = false;
        this.samples = [];
        this.pings = new Set();
        this.rtt = 0;
        this.jitter = 0;

        this.D = 0.5;
        this.DMin = 0.4;
        this.DMax = 2.0;
        this.lastDAdjust = 0;
        this.lastStallAt = 0;
        this.stallStart = 0;

        this.lastHardSeek = 0;
        this.hardSeeks = [];
        this.bigDriftSince = 0;
        this.pendingInitialSeek = true;
        this.allowSeek = false;
        this.allowSeekTimer = 0;
        this.playPromise = null;
        this.emaDrift = 0;
        this.lastStatsAt = 0;
        this.running = false;
        this.startedAt = 0;
        this.timer = null;
        this.pingTimer = null;

        this._onWaiting = () => {
            this.stallStart = performance.now();
            this.lastStallAt = this.stallStart;
            this.onOverlay("buffering", "网络缓冲中…");
        };
        this._onPlaying = () => {
            if (this.stallStart) {
                const duration = performance.now() - this.stallStart;
                if (duration > 200) this.increaseD(0.2);
                this.stallStart = 0;
            }
            this.onOverlay("buffering", null);
        };
        this._onSeeking = () => {
            if (!this.allowSeek) this.followNow(true);
        };
        this._onSeeked = () => {
            this.allowSeek = false;
            clearTimeout(this.allowSeekTimer);
        };
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.startedAt = performance.now();
        this.video.addEventListener("waiting", this._onWaiting);
        this.video.addEventListener("stalled", this._onWaiting);
        this.video.addEventListener("playing", this._onPlaying);
        this.video.addEventListener("seeking", this._onSeeking);
        this.video.addEventListener("seeked", this._onSeeked);
        this.ping();
        this.pingTimer = setInterval(() => this.ping(), 2000);
        this.timer = setInterval(() => this.tick(), 250);
    }

    destroy() {
        this.running = false;
        clearInterval(this.timer);
        clearInterval(this.pingTimer);
        clearTimeout(this.allowSeekTimer);
        this.timer = null;
        this.pingTimer = null;
        this.video.removeEventListener("waiting", this._onWaiting);
        this.video.removeEventListener("stalled", this._onWaiting);
        this.video.removeEventListener("playing", this._onPlaying);
        this.video.removeEventListener("seeking", this._onSeeking);
        this.video.removeEventListener("seeked", this._onSeeked);
    }

    // -- clock ---------------------------------------------------------
    seedServerTime(serverTs) {
        const value = Number(serverTs);
        if (!this.offsetValid && Number.isFinite(value) && value > 0) {
            this.offset = value - Date.now();
            this.offsetValid = true;
        }
    }

    ping() {
        const t0 = Date.now();
        this.pings.add(t0);
        if (this.pings.size > 8) {
            const oldest = this.pings.values().next().value;
            this.pings.delete(oldest);
        }
        this.send({ type: "ping", t0 });
    }

    onPong(message) {
        const t0 = Number(message.t0);
        if (!this.pings.delete(t0)) return;
        const t1 = Number(message.t1);
        const t2 = Number(message.t2);
        const t3 = Date.now();
        const rtt = t3 - t0 - (t2 - t1);
        if (!Number.isFinite(rtt) || rtt < 0 || rtt > 15000) return;
        const offset = (t1 - t0 + (t2 - t3)) / 2;
        this.samples.push({ rtt, offset, at: t3 });
        if (this.samples.length > 30) this.samples.shift();
        this.updateClock();
    }

    updateClock() {
        const now = Date.now();
        const recent = this.samples.filter((sample) => now - sample.at < 60000);
        if (!recent.length) return;
        const byRtt = [...recent].sort((a, b) => a.rtt - b.rtt);
        const best = byRtt.slice(0, Math.min(5, byRtt.length));
        const target = median(best.map((sample) => sample.offset));

        const rtts = recent.map((sample) => sample.rtt);
        this.rtt = median(rtts);
        const center = this.rtt;
        this.jitter = median(rtts.map((value) => Math.abs(value - center)));

        if (!this.offsetValid) {
            this.offset = target;
            this.offsetValid = true;
        } else {
            const delta = target - this.offset;
            if (Math.abs(delta) > 2000) {
                this.offset = target;
                this.samples = this.samples.slice(-5);
            } else if (Math.abs(delta) > 500) {
                this.offset += delta * 0.5;
            } else {
                this.offset += delta * 0.15;
            }
        }
        this.DMin = clamp((this.jitter * 2) / 1000, 0.4, 1.2);
    }

    serverNow() {
        return Date.now() + this.offset;
    }

    // -- timeline ------------------------------------------------------
    setHost(host) {
        if (!host || typeof host !== "object") return;
        const previousSeq = this.host ? Number(this.host.seq) : -1;
        this.host = { ...host };
        if (previousSeq < 0) this.pendingInitialSeek = true;
    }

    targetPosition() {
        const host = this.host;
        if (!host) return null;
        let position = Number(host.position) || 0;
        if (host.playing && !host.buffering) {
            const elapsed = clamp((this.serverNow() - Number(host.updated_at || 0)) / 1000, 0, 5);
            position += elapsed * (Number(host.rate) || 1);
        }
        return Math.max(0, position - this.D);
    }

    shouldPlay() {
        const host = this.host;
        return Boolean(host && host.online !== false && host.playing && !host.buffering);
    }

    // -- corrections ---------------------------------------------------
    followNow(force = false) {
        const target = this.targetPosition();
        if (target == null) return;
        this.hardSeek(target, force);
    }

    hardSeek(target, force = false) {
        const now = performance.now();
        if (!force && now - this.lastHardSeek < 8000) return;

        if (!force) {
            this.hardSeeks.push(now);
            this.hardSeeks = this.hardSeeks.filter((at) => now - at < 60000);
            if (this.hardSeeks.length >= 3) {
                this.increaseD(0.5);
                this.hardSeeks = [];
            }
        }

        this.lastHardSeek = now;
        this.pendingInitialSeek = false;
        this.bigDriftSince = 0;
        this.allowSeek = true;
        clearTimeout(this.allowSeekTimer);
        this.allowSeekTimer = setTimeout(() => {
            this.allowSeek = false;
        }, 3000);

        const video = this.video;
        let destination = Math.max(0, target);
        if (Number.isFinite(video.duration) && video.duration > 0) {
            destination = Math.min(destination, Math.max(0, video.duration - 0.05));
        }
        try {
            video.currentTime = destination;
        } catch {
            // metadata may not be ready yet; the next tick will retry
        }
        this.emaDrift = 0;
        if (this.shouldPlay() && video.paused) this.playSafe();
    }

    increaseD(amount) {
        this.D = clamp(this.D + amount, this.DMin, this.DMax);
        this.lastDAdjust = performance.now();
    }

    tick() {
        const host = this.host;
        if (!host) return;
        const now = performance.now();

        if (this.pendingInitialSeek && this.video.readyState >= 1) {
            this.pendingInitialSeek = false;
            this.hardSeek(this.targetPosition(), true);
        }

        const shouldPlay = this.shouldPlay();
        if (shouldPlay) {
            if (this.video.paused && this.video.readyState >= 1) this.playSafe();
        } else if (!this.video.paused) {
            this.video.pause();
        }

        if (now - this.lastDAdjust > 120000 && now - this.lastStallAt > 120000) {
            this.D = clamp(this.D - 0.1, this.DMin, this.DMax);
            this.lastDAdjust = now;
        }

        if (this.video.readyState < 2 || this.video.seeking) {
            this.report();
            return;
        }

        const target = this.targetPosition();
        if (target == null) {
            this.report();
            return;
        }
        const drift = this.video.currentTime - target;
        this.emaDrift += 0.3 * (drift - this.emaDrift);

        if (!shouldPlay) {
            this.report();
            return;
        }

        const magnitude = Math.abs(drift);
        if (magnitude > 8) {
            this.hardSeek(target, true);
        } else if (magnitude > 3) {
            if (!this.bigDriftSince) this.bigDriftSince = now;
            if (now - this.bigDriftSince > 1000) {
                this.hardSeek(target);
                this.bigDriftSince = 0;
            }
        } else {
            this.bigDriftSince = 0;
            const base = Number(host.rate) || 1;
            let rate = base;
            if (magnitude > 0.5) {
                rate = clamp(base - drift * 0.06, base - 0.1, base + 0.1);
            }
            rate = clamp(rate, 0.25, 4);
            if (Math.abs(this.video.playbackRate - rate) > 0.003) {
                this.video.playbackRate = rate;
            }
        }
        this.report();
    }

    playSafe() {
        if (this.playPromise) return;
        if (!this.video.paused) return;
        let promise;
        try {
            promise = this.video.play();
        } catch (error) {
            this.onPlayBlocked(error);
            return;
        }
        if (!promise || typeof promise.then !== "function") return;
        this.playPromise = promise;
        promise
            .then(() => {
                this.playPromise = null;
                this.onOverlay("buffering", null);
            })
            .catch((error) => {
                this.playPromise = null;
                if (error && error.name === "NotAllowedError") {
                    this.onPlayBlocked(error);
                } else if (error && error.name !== "AbortError") {
                    this.onOverlay("buffering", "播放出错，正在重试…");
                }
            });
    }

    retryPlay() {
        this.playPromise = null;
        return this.video.play().then(
            () => {
                this.onOverlay("buffering", null);
                return true;
            },
            () => false
        );
    }

    report() {
        const now = performance.now();
        if (now - this.lastStatsAt < 400) return;
        this.lastStatsAt = now;
        this.onStats({
            rtt: this.rtt,
            offset: this.offset,
            drift: this.emaDrift,
            d: this.D,
            rate: this.video.playbackRate,
            playing: !this.video.paused,
            buffering: Boolean(this.stallStart) || this.video.readyState < 3,
            online: this.host ? this.host.online !== false : false,
        });
    }
}
