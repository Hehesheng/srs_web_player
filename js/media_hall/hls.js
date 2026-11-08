/**
 * HLS glue for the transcoded path.
 *
 * Jellyfin hands us the item as a VOD playlist whose segments are produced on
 * demand, so the element's clock runs from the item's own first segment --
 * that is what `media_start` names, and item time is `media_start` plus the
 * element's clock.  Where the room wants playback to *begin* is a separate
 * number (`media_resume`), which is what `startAt` carries here.
 *
 * Media Source does the demuxing wherever it exists -- including iOS 17.1+,
 * which exposes ManagedMediaSource for exactly this.  That matters more than it
 * looks: with Media Source the same code path plays everywhere, while the
 * element's own HLS support hands the viewer to the system player, whose
 * pipeline behaves differently (it downloads a VOD playlist the way a
 * progressive file is fetched, ignores `playbackRate`, and hitches on its own
 * schedule).  Phones whose Media Source misbehaves still fall back to the
 * element, which is why nothing here gives up on the stream for good.
 */

const attached = new WeakMap();
// Elements whose Media Source session died: they keep playing the playlist
// natively for the rest of the page's life, because flipping back and forth
// would stall the picture on every retry.  A reload starts fresh.
const nativeOnly = new WeakSet();
// A Media Source session gets one repair attempt; a second fatal media error
// means the engine is not going to survive on this device.
const mediaRepaired = new WeakSet();

export function hlsSupported() {
    return Boolean(window.Hls && window.Hls.isSupported());
}

export function hlsAttached(video) {
    return Boolean(video && attached.has(video));
}

/** Tear the current stream down and leave the element with no source. */
export function detachHls(video) {
    if (!video) return;
    const entry = attached.get(video);
    attached.delete(video);
    if (entry) {
        try {
            entry.instance.destroy();
        } catch {
            // already destroyed
        }
    }
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
}

/** Devices whose only Media Source is the managed one (iOS Safari). */
function managedOnly() {
    return Boolean(window.ManagedMediaSource) && !window.MediaSource;
}

/**
 * Hand the playlist to the element's own HLS pipeline.
 *
 * The safety net rather than the default: the system player fetches a growing
 * VOD playlist the way it fetches a file, ignores `playbackRate`, and paces
 * itself on its own schedule.  A phone that cannot hold a Media Source session
 * open still gets a picture this way, which beats an error card.
 */
function playNative(video, url, startAt = 0) {
    nativeOnly.add(video);
    // The playlist may carry `#EXT-X-START`, but Safari does not promise to
    // honour it in a VOD list, and opening at the item's first segment while
    // the bar shows the host's position is the bug this whole path exists to
    // avoid.  So: open, then land on the room's position ourselves.
    const at = Number(startAt) || 0;
    if (at > 0.5) {
        const move = () => {
            video.removeEventListener("loadedmetadata", move);
            try {
                const end = Number.isFinite(video.duration) && video.duration > 0
                    ? Math.max(0, video.duration - 0.05)
                    : at;
                video.currentTime = Math.min(at, end);
            } catch {
                // Metadata arrived without a seekable range; the item start is
                // a worse position than the room's, but it is still a picture.
            }
        };
        video.addEventListener("loadedmetadata", move);
    }
    video.src = url;
    video.load();
    return null;
}

/**
 * Play `url` on `video`, using hls.js when the browser needs it.
 *
 * `startAt` is where in the stream playback should open (stream time, i.e.
 * item time minus `media_start`); 0 or less means "from the beginning".
 * Returns the hls.js instance, or null when playback falls back to the
 * element's own HLS support (old Safari, a phone that lost its session).
 */
export function attachHls(video, url, { onError, startAt = 0 } = {}) {
    detachHls(video);
    if (!video || !url) return null;

    const at = Math.max(0, Number(startAt) || 0);

    if (!hlsSupported() || nativeOnly.has(video)) {
        // No Media Source here, or this element already lost its session once.
        return playNative(video, url, at);
    }

    const Hls = window.Hls;
    const instance = new Hls({
        // Stay close to the encoder: the host is the timing authority and the
        // playlist only holds a handful of segments.
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 8,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 6,
        fragLoadingTimeOut: 45000,
        fragLoadingMaxRetry: 6,
        // Above 0 this is where hls.js opens the stream; -1 keeps its default
        // of "wherever the playlist says", which is the item's first segment.
        startPosition: at > 0.5 ? at : -1,
        enableWorker: true,
    });
    attached.set(video, { instance });

    instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal) return;
        // A restarted transcode briefly 404s a segment; recovering is cheaper
        // than tearing the whole stream down and rebuilding it.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try {
                instance.startLoad();
                return;
            } catch {
                // fall through to giving up
            }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // One repair, once.  A second fatal media error on a phone whose
            // only Media Source is the managed one means this engine is not
            // going to survive there; drop to the element rather than the
            // error card the caller would show.
            if (mediaRepaired.has(video)) {
                if (managedOnly()) {
                    detachHls(video);
                    // Same room position, different engine: dropping to the
                    // element must not also drop the viewer back to item 0.
                    return playNative(video, url, at);
                }
            } else {
                try {
                    mediaRepaired.add(video);
                    instance.recoverMediaError();
                    return;
                } catch {
                    // fall through to giving up
                }
            }
        }
        detachHls(video);
        if (onError) onError(data);
    });

    instance.loadSource(url);
    instance.attachMedia(video);
    return instance;
}
