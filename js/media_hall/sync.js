/**
 * Member clock + drift controller.
 *
 * The host publishes a server-timestamped timeline.  Every member estimates its
 * clock offset with NTP-style pings and then does two things:
 *
 *   - play at the host's own rate, always
 *   - keep the drift small, by whichever of the two corrections this device can
 *     afford:
 *       - `rateCorrection` (a desktop): ride it out with a small rate change,
 *         at most +/-10% of the host's rate, which nobody can see;
 *       - otherwise (iOS): leave it alone entirely and jump to the target once
 *         when it passes the member's own `seekAt`.
 *
 * The split is not cosmetic.  On iOS every write to `playbackRate` can cost the
 * picture a flush and the engine may ignore it outright, and a phone that
 * cannot exceed real time pays for the ask in stalls -- there the correction
 * costs the viewer more than the drift it removes.  A viewer notices one jump;
 * nobody notices a second of lag, so the drift is left to sit where it settles
 * (about half a second on the phones that reported stutter) until the member's
 * threshold makes one jump worth it.  Intermittent small hitches are much worse
 * than one big one.  Either way the threshold above which a jump is forced is
 * the member's own choice, and `correction: false` turns all of it off.
 *
 * Members always stay D seconds behind the host, where D grows when the local
 * network stalls and, once 60s have passed without a stall, decays every 30s
 * (by 0.2s while it is still well above DMin, by 0.1s once it is close).  A
 * change to D moves the target rather than the element, so it is free.
 */

const MIN_SEEK_INTERVAL = 1500;
const CORRECTION_COOLDOWN = 8000;
// Where the drift stops being latency and gets one seek.  This is the default
// only: every member can pick their own in the room (`setPolicy`), and the
// phones that reported stutter settle within about a second of the target on
// their own, so leaving the drift alone until then is the whole point.
const SEEK_AT = 3.0;
// Past this the element is showing something else entirely and the seek goes
// out without waiting to see whether the drift persists, whatever the member
// chose.
const SEEK_AT_NOW = 8.0;
// The desktop correction: a drift small enough not to be worth a jump is ridden
// out by playing slightly fast or slow.  +/-10% is invisible; the deadband is
// there because the drift estimate moves by hundredths every tick on RTT noise
// alone, and a write per tick is a write per tick.
const RATE_TOLERANCE = 0.15;
const RATE_SLEW = 0.06;
const RATE_CEILING = 0.1;
const RATE_DEADBAND = 0.03;
// What the element delivers per second of wall clock, divided by what it was
// asked for.  1.0 is an engine that plays what it is told; 0.88 is one losing
// an eighth of everything it decodes, which no rate can win back.  Measured
// only from windows in which we did not touch the rate.
// Forward buffer this thin at the moment of a hitch means no data to show.
const STARVED_AHEAD = 0.35;
const D_DECAY_INTERVAL = 30000;
const D_DECAY_STALL_GUARD = 60000;
// How long the position may stand still before the picture counts as starved.
// `waiting`/`stalled` alone are not enough: iOS/Safari fires `stalled` on a
// live HLS stream while playback continues, and no `playing` follows it.
const STALL_CONFIRM_MS = 700;
// Short hitches: too brief to light the buffering overlay, but they cost the
// clock exactly what they cost the picture, so they are counted separately.
// Without this a phone that hitches 400ms every few seconds reads as clean.
const MICRO_FREEZE_MS = 120;
// Long enough that one hitch does not dominate the measured advance ratio.
const ADVANCE_WINDOW_MS = 10000;
// A starved element still gets the occasional seek, because that is what
// re-primes the fetch; rate changes do nothing while the clock is stopped.
const STALL_RECOVER_MS = 5000;
// When the engine refuses the host's rate outright (some iOS streams do), the
// only lever left is a seek, at this minimum spacing.  A deficit past this is
// no longer a correction but a repair: the member is watching a different
// moment from the host, and no threshold anyone would choose makes that right.
// Softer deficits stand -- a seek into one only re-creates it, one buffer flush
// at a time.
const RATE_LOCKED_SEEK_MS = 6000;
const RATE_LOCKED_LAG = 10.0;
// After this many refused rate changes we stop asking and switch to seeks.
const RATE_REFUSE_LIMIT = 3;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

export class SyncController {
    constructor({ video, send, onStats, onOverlay, onPlayBlocked, correction = true, seekAt = SEEK_AT, rateCorrection = true }) {
        this.video = video;
        this.send = send;
        this.onStats = onStats || (() => {});
        this.onOverlay = onOverlay || (() => {});
        this.onPlayBlocked = onPlayBlocked || (() => {});
        // `correction: false` leaves the picture alone entirely -- no
        // correction seeks, no drift steering -- which is both the `?fix=0`
        // reading ("is the stutter ours, or the phone's?") and the member's own
        // 关 setting.  Following the host's rate and play/pause and landing on
        // the room's position at the start still happen.
        this.correction = correction !== false;
        this.seekAt = Number(seekAt) > 0 ? Number(seekAt) : SEEK_AT;
        this.rateCorrection = rateCorrection !== false;

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
        this.lastPos = 0;
        this.lastAdvanceAt = 0;
        this.stallSince = 0;
        this.stallOverlay = false;
        this.rateLocked = false;
        this.rateRefused = 0;
        this.pendingRate = null;

        this.lastHardSeek = -1e9;
        this.lastAnySeek = -1e9;
        this.hardSeeks = [];
        // Counters for the playback that is running now; they are what make a
        // stutter one device sees and another does not measurable rather than
        // a matter of opinion.
        this.stallCount = 0;
        this.stallTotalMs = 0;
        this.microSince = 0;
        this.microCount = 0;
        this.microTotalMs = 0;
        this.stallNoData = false;
        this.microNoData = false;
        // Short hitches split by cause: 缺数据是网络/带宽，管线停是这台设备
        // 自己。两者的处理方向完全相反，只数总数等于没数。
        this.microStarved = 0;
        this.stallStarved = 0;
        // Content time consumed per second of wall clock.  Below 1 the element
        // is losing time -- an engine problem no rate can win against, as
        // opposed to a correction that is merely too slow.
        this.advanceRatio = 1;
        this.advanceAt = 0;
        this.advanceClock = 0;
        // The rate / write count that window was measured under, so a window
        // polluted by our own correction can be thrown away.
        this.advanceRate = 1;
        this.advanceWrites = 0;
        this.rateWrites = 0;
        this.efficiency = 1;
        this.efficiencyValid = false;
        // Times this controller stopped and started the picture, split by why:
        // the host paused, or the host hiccuped and we followed it.
        this.hostPauseCount = 0;
        this.hostStallCount = 0;
        this.playCount = 0;
        this.seekCount = 0;
        this.correctionSeeks = 0;
        this.positionSeeks = 0;
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

        // These only date the last hint that the stream may be behind; whether
        // the picture is actually starved is measured from the clock instead
        // (see measureAdvance), because the events do not pair up on iOS: a
        // lone `stalled` on live HLS leaves the overlay lit forever while the
        // picture runs.
        this._onStallHint = () => {
            this.lastStallAt = performance.now();
        };
        this._onSeeking = () => {
            this.resetAdvanceWindow();
            // A scripted/allowed seek must be reverted immediately, even if a
            // correction just happened.
            if (!this.allowSeek) this.followNow(true, true);
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
        this.video.addEventListener("waiting", this._onStallHint);
        this.video.addEventListener("stalled", this._onStallHint);
        this.video.addEventListener("playing", this._onStallHint);
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
        this.video.removeEventListener("waiting", this._onStallHint);
        this.video.removeEventListener("stalled", this._onStallHint);
        this.video.removeEventListener("playing", this._onStallHint);
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

    // -- local playback health -----------------------------------------
    /**
     * Whether *this* element is starved, measured from its own clock.
     *
     * The obvious signals cannot be trusted here: iOS/Safari keeps a native HLS
     * element at `readyState` 2 for the whole stream while the picture runs, and
     * it fires `stalled` on live streams without playback ever stopping -- so no
     * `playing` follows to clear the "网络缓冲中" overlay, which then stays lit
     * while the picture plays.  A position that does not move is the one honest
     * signal, and everything (overlay, stats flag, D growth) follows from it.
     */
    measureAdvance() {
        const video = this.video;
        const now = performance.now();
        const playing = !video.paused && !video.ended;
        const position = Number(video.currentTime) || 0;
        const moved = Math.abs(position - this.lastPos) > 0.0005;
        if (moved) this.lastPos = position;
        // Only time spent *trying* to play counts: a pause (ours, or the host's)
        // must not look like a stall the moment playback resumes.
        if (moved || !playing || !this.lastAdvanceAt) this.lastAdvanceAt = now;
        const frozenFor = now - this.lastAdvanceAt;
        const stalled = playing && frozenFor > STALL_CONFIRM_MS;

        const starved = this.bufferStarved();
        if (stalled && !this.stallSince) {
            this.stallSince = now - frozenFor;
            this.stallNoData = starved;
        } else if (!stalled && this.stallSince) {
            const duration = now - this.stallSince;
            this.stallSince = 0;
            this.lastStallAt = now;
            if (duration > 200) {
                this.increaseD(duration > 2000 ? 0.4 : 0.2);
                this.stallCount += 1;
                this.stallTotalMs += duration;
                if (this.stallNoData) this.stallStarved += 1;
            }
            this.stallNoData = false;
        }
        // The same measurement with a much lower threshold, so a phone that
        // hitches for a few hundred milliseconds -- and never lights the
        // overlay -- still shows up in the report.
        const short = playing && frozenFor > MICRO_FREEZE_MS;
        if (short) {
            if (!this.microSince) {
                this.microSince = now - frozenFor;
                this.microNoData = starved;
            }
        } else if (this.microSince) {
            const duration = now - this.microSince;
            this.microSince = 0;
            // Longer than STALL_CONFIRM_MS belongs to the stall count above.
            if (duration > MICRO_FREEZE_MS && duration <= STALL_CONFIRM_MS) {
                this.microCount += 1;
                this.microTotalMs += duration;
                if (this.microNoData) this.microStarved += 1;
            }
            this.microNoData = false;
        }
        this.measureAdvanceRatio(playing, position, now);
        this.setStallOverlay(stalled);
        return { stalled, frozenFor, playing };
    }

    /**
     * How much content time the element really consumed per second of clock.
     *
     * 1.00 is an engine keeping up; 0.9 is one losing a tenth of every second
     * to hitches, which no amount of rate correction can recover.  Segments
     * that advance the clock by other means (a seek) restart the window.
     */
    measureAdvanceRatio(playing, position, now) {
        if (!playing) {
            this.advanceAt = 0;
            return;
        }
        if (!this.advanceAt) {
            this.advanceAt = now;
            this.advanceClock = position;
            this.advanceRate = Number(this.video.playbackRate) || 1;
            this.advanceWrites = this.rateWrites;
            return;
        }
        const span = now - this.advanceAt;
        if (span < ADVANCE_WINDOW_MS) return;
        const gained = position - this.advanceClock;
        if (gained >= 0) {
            this.advanceRatio = gained / (span / 1000);
            // Our own correction drives the delivered ratio towards 1, which
            // would make a losing device look healthy -- so a window in which
            // we wrote the rate says nothing about the device and is dropped.
            if (this.rateWrites === this.advanceWrites) {
                const seen = this.advanceRatio / Math.max(0.25, this.advanceRate);
                this.efficiency = this.efficiencyValid
                    ? this.efficiency * 0.6 + seen * 0.4
                    : seen;
                this.efficiencyValid = true;
            }
        }
        this.advanceAt = now;
        this.advanceClock = position;
        this.advanceRate = Number(this.video.playbackRate) || 1;
        this.advanceWrites = this.rateWrites;
    }

    /** A clock jump is not elapsed time; start the window over. */
    resetAdvanceWindow() {
        this.advanceAt = 0;
    }

    /**
     * Nothing to show, or data present and the pipeline stopped anyway?
     *
     * The two read identically in the freeze figures and need opposite fixes:
     * an empty buffer at the playhead is a fetch/bandwidth problem, where the
     * answer is to ask for less bitrate; a full buffer under a stopped clock is
     * the device itself, where asking for a faster rate makes it worse.
     */
    bufferStarved() {
        const video = this.video;
        const position = Number(video.currentTime) || 0;
        try {
            const ranges = video.buffered;
            for (let i = 0; i < ranges.length; i += 1) {
                if (ranges.start(i) <= position + 0.5 && ranges.end(i) > position) {
                    return ranges.end(i) - position < STARVED_AHEAD;
                }
            }
        } catch {
            return true;
        }
        return true;
    }

    /** Own the overlay only while starved, and only when it changes state. */
    setStallOverlay(on) {
        if (on === this.stallOverlay) return;
        this.stallOverlay = on;
        this.onOverlay("buffering", on ? "网络缓冲中…" : null);
    }

    // -- corrections ---------------------------------------------------
    followNow(force = false, urgent = false) {
        const target = this.targetPosition();
        if (target == null) return;
        this.hardSeek(target, force, urgent, "position");
    }

    correctNow() {
        const target = this.targetPosition();
        if (target == null) return false;
        this.hardSeek(target, true, true);
        this.report();
        return true;
    }

    /** Forget the old media's timeline after the host swaps the source. */
    resetForMedia() {
        this.host = null;
        this.pendingInitialSeek = true;
        this.bigDriftSince = 0;
        this.emaDrift = 0;
        this.allowSeek = false;
        this.lastHardSeek = -1e9;
        this.lastAnySeek = -1e9;
        this.hardSeeks = [];
        this.playPromise = null;
        this.lastPos = 0;
        this.lastAdvanceAt = 0;
        this.stallSince = 0;
        this.stallCount = 0;
        this.stallTotalMs = 0;
        this.microSince = 0;
        this.microCount = 0;
        this.microTotalMs = 0;
        this.microStarved = 0;
        this.stallStarved = 0;
        this.stallNoData = false;
        this.microNoData = false;
        this.advanceRatio = 1;
        this.advanceAt = 0;
        // A new stream is a new device reading: whatever we learned about how
        // this element keeps up does not carry over.
        this.efficiency = 1;
        this.efficiencyValid = false;
        this.advanceRate = 1;
        this.advanceWrites = 0;
        this.rateWrites = 0;
        this.hostPauseCount = 0;
        this.hostStallCount = 0;
        this.playCount = 0;
        this.seekCount = 0;
        this.correctionSeeks = 0;
        this.positionSeeks = 0;
        this.rateLocked = false;
        this.rateRefused = 0;
        this.pendingRate = null;
        clearTimeout(this.allowSeekTimer);
        this.setStallOverlay(false);
        this.video.playbackRate = 1;
        this.report();
    }

    hardSeek(target, force = false, urgent = false, kind = "correct") {
        const now = performance.now();
        if (!urgent) {
            if (now - this.lastAnySeek < MIN_SEEK_INTERVAL) return;
            if (!force && now - this.lastHardSeek < CORRECTION_COOLDOWN) return;
        }

        this.lastAnySeek = now;
        this.seekCount += 1;
        if (kind === "position") this.positionSeeks += 1;
        else this.correctionSeeks += 1;
        this.resetAdvanceWindow();
        // Forced seeks (initial positioning, resync) are not corrections and
        // must not block the 3s rule that follows a slow start.
        if (!force) {
            this.lastHardSeek = now;
            this.hardSeeks.push(now);
            this.hardSeeks = this.hardSeeks.filter((at) => now - at < 60000);
            if (this.hardSeeks.length >= 3) {
                this.increaseD(0.5);
                this.hardSeeks = [];
            }
        }
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
        const advance = this.measureAdvance();

        if (this.pendingInitialSeek && this.video.readyState >= 1) {
            this.pendingInitialSeek = false;
            this.hardSeek(this.targetPosition(), true, false, "position");
        }

        const shouldPlay = this.shouldPlay();
        if (shouldPlay) {
            if (this.video.paused && this.video.readyState >= 1) {
                this.playCount += 1;
                this.playSafe();
            }
        } else if (!this.video.paused) {
            // Everyone follows the host, so a host hiccup stops the picture
            // here too -- but it is worth counting: on a phone the restart is
            // what a viewer sees as a stutter, and it never shows up in the
            // stall figures because a pause is not supposed to look like one.
            if (host.online === false || !host.playing) this.hostPauseCount += 1;
            else this.hostStallCount += 1;
            this.video.pause();
        }

        if (now - this.lastDAdjust > D_DECAY_INTERVAL && now - this.lastStallAt > D_DECAY_STALL_GUARD) {
            const step = this.D - this.DMin > 0.6 ? 0.2 : 0.1;
            this.D = clamp(this.D - step, this.DMin, this.DMax);
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

        // A stopped clock cannot be steered: changing the rate of a starved
        // element does nothing, and a seek usually throws away what little it
        // buffered.  Let it recover, with one slow re-priming seek in case the
        // fetch is stuck for good.  This stays on under `?fix=0` -- it is there
        // to keep a dead stream from staying dead, and a test that can leave
        // the picture frozen for good would answer nothing.
        if (advance.stalled) {
            if (advance.frozenFor > STALL_RECOVER_MS && now - this.lastAnySeek > STALL_RECOVER_MS) {
                this.hardSeek(target, true);
            }
            this.report();
            return;
        }

        // `?fix=0` / 关: no correction seek, and nothing driving the drift.  What
        // is left is what the device does on its own, which is the number the
        // test is after.  The host's own rate is still followed -- otherwise
        // the reading would be of a member playing at 1.0x for no reason.
        if (!this.correction) {
            this.applyRate(host, 0);
            this.report();
            return;
        }

        const magnitude = Math.abs(drift);
        if (this.rateLocked) {
            this.lockedSeek(drift, target, magnitude, now);
        } else if (magnitude > SEEK_AT_NOW) {
            this.hardSeek(target, true);
        } else if (magnitude > this.seekAt) {
            if (!this.bigDriftSince) this.bigDriftSince = now;
            if (now - this.bigDriftSince > 1000) {
                this.hardSeek(target);
                this.bigDriftSince = 0;
            }
        } else {
            // Under the member's own threshold: a desktop rides this out with
            // the rate (see applyRate), a phone is left exactly as it is.  The
            // drift a phone accumulates on its own settles below this, and
            // every correction we could aim at it costs the picture a flush
            // that lasts longer than the drift did.
            this.bigDriftSince = 0;
        }
        this.applyRate(host, drift);
        this.report();
    }

    /**
     * Change the correction while the room is open -- the member's own setting.
     *
     * `seekAt` is the drift at which one jump is worth making; `correction:
     * false` turns everything off; `rateCorrection` says whether the drift
     * under that threshold is also ridden out by a small rate change (a
     * desktop can afford that, a phone cannot).  Anything left out is
     * unchanged.
     */
    setPolicy({ correction, seekAt, rateCorrection } = {}) {
        if (correction !== undefined) this.correction = correction !== false;
        if (seekAt !== undefined && Number(seekAt) > 0) this.seekAt = Number(seekAt);
        if (rateCorrection !== undefined) this.rateCorrection = rateCorrection !== false;
        // The next tick puts the element back on the host's rate if the
        // correction it was carrying is no longer wanted (`applyRate` always
        // writes a release), so there is nothing to undo here.
        this.report();
    }

    /**
     * The one correction left for an element that will not take a rate at all.
     *
     * iOS Safari ignores playbackRate on some live HLS streams, and nothing
     * drains a lead for such an element, so a lead past the member's own
     * threshold gets a seek -- the setting means the same thing here as it does
     * everywhere else.  A deficit gets one only when it is past anything a
     * viewer would call latency: a small one would be re-created by the seek
     * itself, one flush at a time, which is the churn this file exists to
     * avoid.
     */
    lockedSeek(drift, target, magnitude, now) {
        this.bigDriftSince = 0;
        const worth = drift > this.seekAt || magnitude > RATE_LOCKED_LAG;
        if (worth && now - this.lastAnySeek > RATE_LOCKED_SEEK_MS) this.hardSeek(target, true);
    }

    /**
     * Is the rate actually being used to hold the drift right now?
     *
     * One definition for both readers (the health line and `__hallDebug`):
     * the setting says what the member asked for, this says what is happening.
     */
    rateCorrecting() {
        return Boolean(this.correction && this.rateCorrection && !this.rateLocked);
    }

    /**
     * What rate the element should be at, and whether it is worth a write.
     *
     * Two jobs share the one property, so they share one place: follow the
     * host's own rate (a host watching at 1.5x has to be followed at 1.5x), and
     * -- only where a write is free -- ride out a small drift within +/-10% of
     * it.  `rateCorrection` is the device's answer to "is a write free"; when
     * it is off the rate is never anything but the host's own, and the drift is
     * the member's jump threshold's business.  The one thing worth noticing
     * either way is an element that refuses even the host's rate, which after a
     * few tries switches to seeks.
     */
    applyRate(host, drift) {
        if (this.rateLocked) return;
        const base = clamp(Number(host.rate) || 1, 0.25, 4);
        let want = base;
        if (this.rateCorrection && Math.abs(drift) > RATE_TOLERANCE) {
            want = clamp(base - drift * RATE_SLEW, base - RATE_CEILING, base + RATE_CEILING);
        }
        const current = Number(this.video.playbackRate) || 1;
        if (Math.abs(current - want) <= 0.005) {
            this.pendingRate = null;
            this.rateRefused = 0;
            return;
        }
        // A request is refused when the element drops back to 1 (or never
        // leaves it) after we asked for something else.
        const refused = this.pendingRate !== null
            && Math.abs(this.pendingRate - 1) > 0.005
            && Math.abs(current - 1) <= 0.005;
        if (refused) {
            this.rateRefused += 1;
            if (this.rateRefused >= RATE_REFUSE_LIMIT) {
                this.rateLocked = true;
                this.rateRefused = 0;
                this.pendingRate = null;
                console.info("[hall] 播放器不接受倍速调整，改用跳转纠偏");
                return;
            }
        }
        // A correction smaller than the deadband is not worth a write, but a
        // release back to the host's own rate always is: leaving a stale
        // correction in place is worse than any flush.
        const releasing = Math.abs(want - base) <= 0.005;
        if (!releasing && Math.abs(want - current) < RATE_DEADBAND) return;
        this.rateWrites += 1;
        this.video.playbackRate = want;
        this.pendingRate = want;
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

    /**
     * Playback health as the numbers a stutter report needs.
     *
     * A hitch that never lights the buffering overlay leaves no trace in the
     * drift figures, so the interesting values are the engine's own: how far
     * ahead of the clock it has data, how many frames it rendered and dropped,
     * and how many freezes we measured with `measureAdvance`.
     */
    healthSnapshot() {
        const video = this.video;
        const position = Number(video.currentTime) || 0;
        let buffer = 0;
        try {
            const ranges = video.buffered;
            for (let i = 0; i < ranges.length; i += 1) {
                if (ranges.start(i) <= position + 0.5 && ranges.end(i) > position) {
                    buffer = Math.max(buffer, ranges.end(i) - position);
                }
            }
        } catch {
            // No decoder state yet; "no forward buffer" is the honest read.
        }
        let quality = null;
        try {
            quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        } catch {
            // Not every engine exposes it, and the element may be sourceless.
        }
        return {
            buffer,
            dropped: quality ? quality.droppedVideoFrames : null,
            frames: quality ? quality.totalVideoFrames : null,
            stalls: this.stallCount,
            stallMs: Math.round(this.stallTotalMs),
            // Hitches too short to be counted as stalls above, and how many of
            // them had no data to show rather than a stalled pipeline.
            shortStalls: this.microCount,
            shortStallMs: Math.round(this.microTotalMs),
            shortStarved: this.microStarved,
            stallStarved: this.stallStarved,
            // What this element delivers per second of wall clock, divided by
            // what it was asked for.  Below 1 the device -- not the network --
            // is where the time goes.
            efficiency: this.efficiencyValid ? this.efficiency : null,
            // How many times we touched the rate.  Should stay at 0 unless the
            // host itself changed rate: every write can cost a hitch.
            rateWrites: this.rateWrites,
            seeks: this.seekCount,
            correctionSeeks: this.correctionSeeks,
            positionSeeks: this.positionSeeks,
            // Content time per second of wall clock; below 1 the engine is
            // losing time rather than merely being corrected slowly.
            advance: this.advanceRatio,
            // Times we stopped and started the picture following the host; on
            // a phone each restart costs a re-prime the host never notices.
            hostPauses: this.hostPauseCount,
            hostStalls: this.hostStallCount,
            resumes: this.playCount,
            // The member's own correction setting: 关 means the rate above says
            // nothing about the device, so the reading has to say so itself.
            correction: this.correction,
            seekAt: this.correction ? this.seekAt : null,
            rateCorrection: this.rateCorrecting(),
        };
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
            rateLocked: this.rateLocked,
            playing: !this.video.paused,
            buffering: Boolean(this.stallSince),
            online: this.host ? this.host.online !== false : false,
            health: this.healthSnapshot(),
        });
    }
}
