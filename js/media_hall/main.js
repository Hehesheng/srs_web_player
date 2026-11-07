/**
 * Media hall page controller: landing actions, room creation/join, view
 * switching and the small amount of chrome around the two player modes.
 */

import { HostController } from "./host.js";
import { JellyfinPicker } from "./jellyfin.js";
import { MemberController } from "./member.js";
import { parseRoomRef } from "./protocol.js";
import {
    $,
    copyText,
    fmtBytes,
    fmtTime,
    renderMembers,
    setStatusBadge,
    showError,
    showView,
    toast,
} from "./ui.js";

const HOST_KEY = "hall_host_session";
const MEMBER_PREFIX = "hall_member_";
const MAX_HOST_FILE_BYTES = 64 * 1024 * 1024 * 1024;
const AUTOPLAY_KEY = "hall_autoplay";
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const SUBTITLE_TRACK_FLAG = "hallSubtitle";
const SUBTITLE_TRACK_SELECTOR = "track[data-hall-subtitle]";
const SUBTITLE_SIZE_KEY = "hall_subtitle_size";
const SUBTITLE_SIZE_CLASSES = ["cue-small", "cue-medium", "cue-large"];
const WIDE_MODE_KEY = "hall_wide_mode";

let hostRoomState = null;
let hostRoomStateTs = 0;
let hostSubtitleMenuSignature = "";
let memberRoomState = null;
let memberRoomStateTs = 0;
let memberSubtitlesVisible = true;
// The track a member picked for themselves; null means "follow the room".
// It never leaves this browser, so each viewer can choose independently.
let memberSubtitleChoice = null;
let memberSubtitleHostId = null;
let memberSubtitleHostVisible = true;
let memberSubtitleMenuSignature = "";
let wideMode = false;

const state = {
    role: null,
    room: null,
    host: null,
    member: null,
    // Playlist entries the host picked in this tab; needed to serve bytes.
    playlistFiles: new Map(),
    playlist: [],
};

const overlayEntries = new Map();
let roomListTimer = null;
const OVERLAY_PRIORITY = ["ended", "fatal", "offline", "blocked", "connecting", "media", "paused", "buffering"];
let overlayAction = null;

// -- helpers ---------------------------------------------------------
async function request(path, options = {}) {
    const init = { method: options.method || "GET", headers: { ...(options.headers || {}) } };
    if (options.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
    }
    let response;
    try {
        response = await fetch(path, init);
    } catch {
        throw new Error("网络请求失败，请检查连接后重试");
    }
    const text = await response.text();
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { message: text };
        }
    }
    if (!response.ok) {
        const error = new Error(data.message || `请求失败（HTTP ${response.status}）`);
        error.code = data.code;
        error.status = response.status;
        throw error;
    }
    return data;
}

function memberKey(code) {
    return `${MEMBER_PREFIX}${String(code || "").toUpperCase()}`;
}

function readMemberSession(code) {
    try {
        const raw = sessionStorage.getItem(memberKey(code));
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveMemberSession(session) {
    try {
        sessionStorage.setItem(memberKey(session.room_code), JSON.stringify(session));
    } catch {
        // private mode / quota; membership still works for this page load
    }
}

function shareLink(code) {
    return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(code)}`;
}

function isLikelyVideo(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith("video/")) return true;
    return /\.(mp4|m4v|webm|ogv|ogg|mov|mkv)$/i.test(file.name || "");
}

function isLikelySubtitle(file) {
    return Boolean(file && /\.(vtt|srt)$/i.test(file.name || ""));
}

function subtitleLang(name) {
    const stem = String(name || "").replace(/\.[^.]+$/, "");
    const tail = (stem.split(/[._-]/).pop() || "").toLowerCase();
    return /^[a-z]{2,3}$/.test(tail) ? tail : "und";
}

function validateSubtitleFile(file) {
    if (!file) return null;
    if (!isLikelySubtitle(file)) return "字幕仅支持 .srt 或 .vtt 文件";
    if (file.size > MAX_SUBTITLE_BYTES) return "字幕文件不能超过 10MB";
    if (file.size === 0) return "字幕文件为空";
    return null;
}

async function uploadSubtitle(session, file, options = {}) {
    const name = options.name || file.name || "subtitles.vtt";
    const params = new URLSearchParams({ name, lang: options.lang || subtitleLang(name) });
    // Tracks read out of a playlist item are only offered while it plays.
    if (options.mediaId) params.set("media_id", options.mediaId);
    let response;
    try {
        response = await fetch(
            `/hall/api/rooms/${encodeURIComponent(session.room_id)}/subtitles?${params}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "X-Host-Token": session.host_token,
                },
                body: file,
            }
        );
    } catch {
        throw new Error("字幕上传失败，请检查网络");
    }
    const text = await response.text();
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { message: text };
        }
    }
    if (!response.ok) {
        throw new Error(data.message || `字幕上传失败（HTTP ${response.status}）`);
    }
    return data;
}

function removeSubtitleTracks(video) {
    if (!video) return;
    video.querySelectorAll(SUBTITLE_TRACK_SELECTOR).forEach((track) => track.remove());
}

function addSubtitleTrack(video, subtitle, visible) {
    removeSubtitleTracks(video);
    if (!video || !subtitle || !subtitle.url) return null;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = subtitle.name || subtitle.lang || "字幕";
    track.srclang = subtitle.lang || "und";
    track.src = subtitle.url;
    track.dataset[SUBTITLE_TRACK_FLAG] = "1";
    track.dataset.subtitleId = subtitle.subtitle_id;
    video.appendChild(track);
    if (track.track) track.track.mode = visible ? "showing" : "hidden";
    return track;
}

function setSubtitleTrackMode(video, visible) {
    if (!video) return;
    video.querySelectorAll(SUBTITLE_TRACK_SELECTOR).forEach((track) => {
        if (track.track) track.track.mode = visible ? "showing" : "hidden";
    });
}

function subtitleListOf(roomState) {
    return roomState && Array.isArray(roomState.subtitles) ? roomState.subtitles : [];
}

function findActiveSubtitle(roomState) {
    const activeId = (roomState && roomState.active_subtitle_id) || null;
    if (!activeId) return null;
    return subtitleListOf(roomState).find((item) => item.subtitle_id === activeId) || null;
}

// -- embedded subtitle tracks ----------------------------------------
// Browsers keep container subtitle tracks to themselves, so the host reads
// them once and uploads them as ordinary room subtitles for that item.
const embeddedSubsScanned = new Set();
// Codec facts per media id, so a playback failure can name the culprit.
const mediaCodecInfo = new Map();

function uploadEmbeddedTracks(session, mediaId, tracks) {
    return (async () => {
        let added = 0;
        for (const item of tracks) {
            try {
                const blob = new Blob([item.vtt], { type: "text/vtt;charset=utf-8" });
                await uploadSubtitle(session, blob, {
                    name: item.name,
                    lang: item.lang,
                    mediaId,
                });
                added += 1;
            } catch (error) {
                console.debug("内嵌字幕上传失败", error);
            }
        }
        if (added) toast(`已识别 ${added} 条内嵌字幕`, "success");
        return added;
    })();
}

// MKV has no seek index for subtitles: finding the cue blocks means walking
// every cluster, so this only runs for local files and only when the header
// says there is a text track worth reading.
async function extractMkvSubtitles(session, mediaId, file) {
    const mkv = window.HallMkv;
    if (!mkv) return;
    let header = null;
    try {
        header = await mkv.analyze(file);
    } catch (error) {
        console.debug("MKV 头部解析失败", error);
        return;
    }
    if (!header) return;
    mediaCodecInfo.set(mediaId, header.info);
    const readable = header.info.subtitles.filter((item) => item.format);
    if (!readable.length) return;
    toast("正在解析 MKV 内嵌字幕…", "info");
    let result = null;
    let lastPercent = -1;
    try {
        result = await mkv.scan(file, {
            onProgress: (ratio) => {
                const percent = Math.round(ratio * 100);
                if (ratio >= 1 || percent === lastPercent) return;
                lastPercent = percent;
                toast(`正在解析 MKV 内嵌字幕… ${percent}%`, "info");
            },
        });
    } catch (error) {
        console.debug("MKV 内嵌字幕解析失败", error);
        return;
    }
    if (!result || !result.tracks.length) {
        toast("这个 MKV 里没有可提取的文字字幕", "info");
        return;
    }
    await uploadEmbeddedTracks(session, mediaId, result.tracks);
}

async function extractEmbeddedSubtitles(session, mediaId, media, source) {
    const lib = window.HallEmbeddedSubs;
    if (!session || !session.host_token || !mediaId || !media) return;
    if (embeddedSubsScanned.has(mediaId)) return;
    embeddedSubsScanned.add(mediaId);
    // MKV is only reachable as a local file: a URL item would have to be pulled
    // down in full to find its cues.
    if (window.HallMkv && window.HallMkv.isMkvMedia(media) && source && source.file) {
        await extractMkvSubtitles(session, mediaId, source.file);
        return;
    }
    if (!lib || !lib.isMp4Media(media)) return;
    let parsed = null;
    try {
        parsed = await lib.extractSubtitles(source);
    } catch (error) {
        console.debug("内嵌字幕解析失败", error);
        return;
    }
    if (!parsed) return;
    if (parsed.info && !mediaCodecInfo.has(mediaId)) mediaCodecInfo.set(mediaId, parsed.info);
    if (!parsed.tracks || !parsed.tracks.length) return;
    await uploadEmbeddedTracks(session, mediaId, parsed.tracks);
}

function setButtonsBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
        button.dataset.label = button.textContent;
        button.textContent = label || "处理中…";
        button.disabled = true;
        button.classList.add("opacity-60");
    } else {
        if (button.dataset.label) button.textContent = button.dataset.label;
        button.disabled = false;
        button.classList.remove("opacity-60");
    }
}

// -- landing ---------------------------------------------------------
function validateHostFile(file) {
    if (!file) return "没有选择文件";
    if (!isLikelyVideo(file)) return "请选择浏览器可播放的视频文件（mp4 / webm / mkv 等）";
    if (file.size <= 0) return "文件为空，无法播放";
    if (file.size > MAX_HOST_FILE_BYTES) return "文件超过 64GB，暂不支持";
    return null;
}

async function createRoom() {
    showError("create-error", "");
    const name = ($("create-name").value || "").trim() || "媒体播放厅";

    await endStoredHostSession();
    const button = $("btn-create");
    setButtonsBusy(button, true, "正在创建…");
    try {
        // The room starts empty; the host picks what to watch from inside it.
        const data = await request("/hall/api/rooms", { method: "POST", body: { name } });
        const session = {
            room_id: data.room_id,
            room_code: data.room_code,
            host_token: data.host_token,
            media_url: data.media_url,
            name,
            media: data.media,
        };
        state.room = session;
        persistHostSession();
        window.history.replaceState({}, "", `?room=${encodeURIComponent(data.room_code)}`);
        startHost(session, null, data.room);
    } catch (error) {
        showError("create-error", error.message || "创建房间失败");
    } finally {
        setButtonsBusy(button, false);
    }
}

async function joinRoom() {
    showError("join-error", "");
    const raw = $("join-code").value || "";
    const code = parseRoomRef(raw);
    if (!code) {
        showError("join-error", "请输入房间码或分享链接");
        return;
    }
    const name = ($("join-name").value || "").trim() || "访客";
    try {
        localStorage.setItem("hall_member_name", name);
    } catch {
        // ignore
    }

    const button = $("btn-join");
    setButtonsBusy(button, true, "正在加入…");
    try {
        const data = await request(`/hall/api/rooms/${encodeURIComponent(code)}/join`, {
            method: "POST",
            body: { name },
        });
        const session = {
            member_token: data.member_token,
            member_id: data.member_id,
            room_id: data.room_id,
            room_code: data.room_code,
            media_url: data.media_url,
            media: data.media,
            name,
            room_name: (data.room && data.room.name) || "",
        };
        saveMemberSession(session);
        window.history.replaceState({}, "", `?room=${encodeURIComponent(data.room_code)}`);
        startMember(session, data.room);
    } catch (error) {
        showError("join-error", error.message || "加入房间失败");
    } finally {
        setButtonsBusy(button, false);
    }
}

// -- room list -------------------------------------------------------
function roomSummaryLine(room) {
    const parts = [`${Number(room.member_count) || 0} 人`];
    if (!room.host_online) parts.push("房主离线");
    if (room.media_name) parts.push(room.media_name);
    else if (Number(room.playlist_count) > 0) parts.push(`${room.playlist_count} 个视频`);
    else parts.push("等待添加内容");
    return parts.join(" · ");
}

function renderRoomList(rooms) {
    const list = $("room-list");
    if (!list) return;
    list.replaceChildren();
    if (!Array.isArray(rooms) || rooms.length === 0) {
        const empty = document.createElement("li");
        empty.className = "text-slate-600";
        empty.textContent = "暂无进行中的房间，创建一个吧";
        list.appendChild(empty);
        return;
    }
    for (const room of rooms) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className =
            "flex w-full items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-slate-900/50 px-3 py-2 text-left transition hover:border-sky-500/50 hover:bg-sky-500/10";
        button.title = `加入 ${room.name || room.room_code}`;

        const left = document.createElement("div");
        left.className = "min-w-0";
        const name = document.createElement("div");
        name.className = "truncate text-xs font-semibold text-slate-200";
        name.textContent = room.name || "媒体播放厅";
        const meta = document.createElement("div");
        meta.className = "mt-0.5 truncate text-[10px] text-slate-500";
        meta.textContent = roomSummaryLine(room);
        left.append(name, meta);

        const code = document.createElement("span");
        code.className = "shrink-0 font-mono text-[11px] tracking-[0.15em] text-sky-300";
        code.textContent = room.room_code;

        button.append(left, code);
        button.addEventListener("click", () => {
            $("join-code").value = room.room_code;
            joinRoom();
        });
        item.appendChild(button);
        list.appendChild(item);
    }
}

async function refreshRoomList() {
    if (state.role) return;
    const list = $("room-list");
    if (!list) return;
    try {
        const data = await request("/hall/api/rooms");
        renderRoomList(data.rooms);
    } catch {
        if (!list.childElementCount) {
            const failed = document.createElement("li");
            failed.className = "text-slate-600";
            failed.textContent = "房间列表加载失败，请点刷新重试";
            list.appendChild(failed);
        }
    }
}

function startRoomListPolling() {
    if (roomListTimer) return;
    roomListTimer = setInterval(() => {
        if (state.role || document.visibilityState !== "visible") return;
        refreshRoomList();
    }, 5000);
}

// -- host ------------------------------------------------------------
function updateHostMembers(members) {
    const list = Array.isArray(members) ? members : [];
    const connected = list.filter((member) => member.connected).length;
    const display = list.map((member) => ({
        ...member,
        name: member.connected ? member.name : `${member.name}（离线）`,
    }));
    $("host-member-count").textContent = String(connected);
    renderMembers($("host-members"), display, {
        emptyText: "还没有成员加入",
    });
}

// -- playlist --------------------------------------------------------
// Transcodes have no byte size, so they are described by length instead.
function mediaMeta(media) {
    if (!media) return "";
    const bits = [];
    if (Number(media.duration) > 0) bits.push(fmtTime(Number(media.duration)));
    if (Number(media.size) > 0) bits.push(fmtBytes(Number(media.size)));
    if (media.playback_mode === "hls") bits.push("转码");
    else if (media.kind === "jellyfin") bits.push("Jellyfin");
    return bits.join(" · ");
}

function hostMediaLabel(media) {
    if (!media) return "播放列表为空";
    const meta = mediaMeta(media);
    return meta ? `${media.name} · ${meta}` : media.name;
}

function updateHostMediaLabel(media) {
    const label = $("host-media-name");
    if (label) label.textContent = hostMediaLabel(media);
}

function setHostPlaylist(items) {
    state.playlist = Array.isArray(items) ? items : [];
    renderHostPlaylist();
}

function renderHostPlaylist() {
    const list = $("host-playlist");
    if (!list) return;
    list.replaceChildren();
    if (!state.playlist.length) {
        const empty = document.createElement("li");
        empty.className = "text-xs italic text-slate-600";
        empty.textContent = "播放列表为空，点上面的「本地文件」「网络地址」或「Jellyfin 媒体库」添加";
        list.appendChild(empty);
        return;
    }
    state.playlist.forEach((item, index) => {
        const row = document.createElement("li");
        row.className =
            "flex items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-2";

        const left = document.createElement("div");
        left.className = "min-w-0";
        const title = document.createElement("div");
        title.className = `truncate text-xs font-semibold ${item.active ? "text-sky-300" : "text-slate-200"}`;
        title.textContent = `${index + 1}. ${item.name || "视频"}`;
        const meta = document.createElement("div");
        meta.className = "mt-0.5 text-[10px] text-slate-500";
        meta.textContent = [item.active ? "播放中" : "", mediaMeta(item)]
            .filter(Boolean)
            .join(" · ");
        left.append(title, meta);

        const actions = document.createElement("div");
        actions.className = "flex shrink-0 items-center gap-2";
        if (!item.active) {
            const playButton = document.createElement("button");
            playButton.type = "button";
            playButton.className =
                "rounded-lg border border-slate-700/60 bg-slate-900/60 px-2 py-1 text-[10px] font-bold text-slate-300 transition hover:border-sky-500/50 hover:text-sky-300";
            playButton.textContent = "播放";
            playButton.addEventListener("click", () => playPlaylistItem(item));
            actions.appendChild(playButton);
        }
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className =
            "rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300 transition hover:bg-rose-500/20";
        removeButton.textContent = "移除";
        removeButton.addEventListener("click", () => removePlaylistItem(item));
        actions.appendChild(removeButton);

        row.append(left, actions);
        list.appendChild(row);
    });
}

function autoplayEnabled() {
    const box = $("host-autoplay");
    return box ? box.checked : true;
}

function applyHostPlaylistPayload(data) {
    if (!data) return;
    if (Array.isArray(data.playlist)) setHostPlaylist(data.playlist);
    if ("media" in data) updateHostMediaLabel(data.media);
    // The playlist response carries the room snapshot; taking the stream
    // details from it lets the switch start before the websocket catches up.
    noteStream(data.room, data.media_url);
}

// The transcoder's epoch names one continuous stream.  A seek bumps it, and
// every player then has to follow the new one instead of the dead old stream.
let hostAttachedEpoch = -1;
// Where the room's current stream starts, kept fresh from every payload that
// carries it so a switch never has to wait for a websocket round trip.
const hostStream = { epoch: 0, start: 0, url: null };

function noteStream(fields, url) {
    if (!fields) return;
    if (fields.media_epoch !== undefined) hostStream.epoch = Number(fields.media_epoch) || 0;
    if (fields.media_start !== undefined) {
        hostStream.start = Math.max(0, Number(fields.media_start) || 0);
    }
    if (url !== undefined) hostStream.url = url;
}

function roomMediaStart() {
    return hostStream.start;
}

function roomMediaEpoch() {
    return hostStream.epoch;
}

// Ask the server to restart the transcode at `position`.  The restart bumps the
// epoch, and followHostStream() picks the new stream up from there; repeated
// calls are cheap because the server keeps only the last target.
async function requestHlsSeek(position) {
    const session = state.room;
    if (!session || !state.host) return;
    const duration = state.host.effectiveDuration();
    let target = Math.max(0, Number(position) || 0);
    if (duration > 1) target = Math.min(target, duration - 1);
    try {
        await request(`/hall/api/rooms/${encodeURIComponent(session.room_id)}/hls/seek`, {
            method: "POST",
            headers: { "X-Host-Token": session.host_token },
            body: { position: target },
        });
    } catch (error) {
        toast(error.message || "跳转失败", "error");
    }
}

function switchHostToMedia(media, mediaUrl) {
    const host = state.host;
    if (!host) return;
    if (!media) {
        host.clearMedia();
        hostAttachedEpoch = -1;
        return;
    }
    if (media.playback_mode === "hls") {
        // Server-side transcode: the browser gets a growing playlist whose
        // clock starts wherever the transcode started, not at the item start.
        host.switchHls(mediaUrl || hostStream.url || (state.room && state.room.media_url), {
            start: roomMediaStart(),
            duration: Number(media.duration) || 0,
        });
        hostAttachedEpoch = roomMediaEpoch();
        return;
    }
    const url = mediaUrl || (state.room && state.room.media_url);
    if (media.kind === "url" || media.kind === "jellyfin") {
        host.switchUrl(url);
        hostAttachedEpoch = roomMediaEpoch();
        // A remote file can only be read through the relay while it plays, so
        // its subtitle tracks are picked up here rather than when it was added.
        if (media.kind === "url" && url && media.range_supported !== false) {
            extractEmbeddedSubtitles(state.room, media.media_id, media, {
                url,
                size: media.size,
            });
        }
        return;
    }
    const file = state.playlistFiles.get(media.media_id);
    if (!file) {
        toast("这个文件的本地副本已丢失，请重新添加该文件", "error");
        return;
    }
    host.switchFile(file, media.media_id);
    hostAttachedEpoch = roomMediaEpoch();
}

async function addHostFiles(files) {
    const session = state.room;
    if (!session || !state.host || !Array.isArray(files) || !files.length) return;
    for (const file of files) {
        const problem = validateHostFile(file);
        if (problem) {
            toast(`${file.name}：${problem}`, "error");
            continue;
        }
        try {
            const data = await request(
                `/hall/api/rooms/${encodeURIComponent(session.room_id)}/playlist`,
                {
                    method: "POST",
                    headers: { "X-Host-Token": session.host_token },
                    body: {
                        kind: "host_file",
                        name: file.name,
                        size: file.size,
                        mime: file.type || "application/octet-stream",
                    },
                }
            );
            state.playlistFiles.set(data.media_id, file);
            session.media = data.media;
            session.media_url = data.media_url;
            persistHostSession();
            applyHostPlaylistPayload(data);
            extractEmbeddedSubtitles(session, data.media_id, file, { file });
            if (data.active) {
                switchHostToMedia(data.media, data.media_url);
                state.host.play();
            }
            toast(`已添加「${file.name}」`, "success");
        } catch (error) {
            toast(`${file.name}：${error.message || "添加失败"}`, "error");
        }
    }
}

async function addHostUrl() {
    const session = state.room;
    if (!session || !state.host) return;
    const input = $("host-url-input");
    const button = $("btn-submit-url");
    if (button.disabled) return;
    const url = (input.value || "").trim();
    if (!/^https?:\/\//i.test(url)) {
        toast("请输入 http(s) 开头的视频地址", "error");
        input.focus();
        return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "正在探测…";
    try {
        // The server probes the address before accepting the item, so this can
        // take a moment; the item itself is served through the hall relay.
        const data = await request(
            `/hall/api/rooms/${encodeURIComponent(session.room_id)}/playlist`,
            {
                method: "POST",
                headers: { "X-Host-Token": session.host_token },
                body: { kind: "url", url },
            }
        );
        session.media = data.media;
        session.media_url = data.media_url;
        persistHostSession();
        applyHostPlaylistPayload(data);
        if (data.active) {
            switchHostToMedia(data.media, data.media_url);
            state.host.play();
        }
        const added = (data.playlist || []).find((item) => item.media_id === data.media_id);
        input.value = "";
        toast(`已添加「${(added && added.name) || "网络视频"}」`, "success");
    } catch (error) {
        toast(error.message || "添加失败", "error");
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}

let jellyfinPicker = null;

function jellyfin() {
    if (!jellyfinPicker) {
        jellyfinPicker = new JellyfinPicker({
            request,
            getRoom: () => state.room,
            toast,
            onPick: (item) => addJellyfinItem(item),
        });
    }
    return jellyfinPicker;
}

async function addJellyfinItem(item) {
    const session = state.room;
    if (!session || !state.host || !item) return;
    try {
        const data = await request(
            `/hall/api/rooms/${encodeURIComponent(session.room_id)}/playlist`,
            {
                method: "POST",
                headers: { "X-Host-Token": session.host_token },
                body: { kind: "jellyfin", item_id: item.id },
            }
        );
        session.media = data.media;
        session.media_url = data.media_url;
        persistHostSession();
        applyHostPlaylistPayload(data);
        if (data.active) {
            // The film is starting behind the picker, so get out of its way.
            if (jellyfinPicker) jellyfinPicker.close();
            switchHostToMedia(data.media, data.media_url);
            state.host.play();
        }
        toast(`已添加「${item.name || "Jellyfin 影片"}」`, "success");
    } catch (error) {
        toast(error.message || "添加失败", "error");
        throw error;
    }
}

async function playPlaylistItem(item) {
    const session = state.room;
    if (!session || !state.host || !item) return;
    if (item.kind === "host_file" && !state.playlistFiles.has(item.media_id)) {
        toast("这个文件的本地副本已丢失，请重新添加该文件", "error");
        return;
    }
    try {
        const data = await request(
            `/hall/api/rooms/${encodeURIComponent(session.room_id)}/playlist/${encodeURIComponent(item.media_id)}/activate`,
            { method: "POST", headers: { "X-Host-Token": session.host_token } }
        );
        session.media = data.media;
        session.media_url = data.media_url;
        persistHostSession();
        applyHostPlaylistPayload(data);
        switchHostToMedia(data.media, data.media_url);
        state.host.play();
    } catch (error) {
        toast(error.message || "切换视频失败", "error");
    }
}

async function removePlaylistItem(item) {
    const session = state.room;
    if (!session || !state.host || !item) return;
    if (!window.confirm(`从播放列表移除「${item.name || "这个视频"}」？`)) return;
    try {
        const data = await request(
            `/hall/api/rooms/${encodeURIComponent(session.room_id)}/playlist/${encodeURIComponent(item.media_id)}`,
            { method: "DELETE", headers: { "X-Host-Token": session.host_token } }
        );
        state.playlistFiles.delete(item.media_id);
        session.media = data.media;
        session.media_url = data.media_url;
        persistHostSession();
        applyHostPlaylistPayload(data);
        if (item.active) switchHostToMedia(data.media, data.media_url);
        toast("已从播放列表移除", "success");
    } catch (error) {
        toast(error.message || "移除失败", "error");
    }
}

function handleHostEnded() {
    const items = Array.isArray(state.playlist) ? state.playlist : [];
    const index = items.findIndex((item) => item.active);
    const next = index >= 0 ? items[index + 1] : null;
    if (!autoplayEnabled()) return;
    if (!next) {
        toast("播放列表已播完", "info");
        return;
    }
    playPlaylistItem(next);
}

function hostActiveSubtitle() {
    const activeId = (hostRoomState && hostRoomState.active_subtitle_id) || null;
    if (!activeId) return null;
    return subtitleListOf(hostRoomState).find((item) => item.subtitle_id === activeId) || null;
}

function updateHostSubtitleButton(subtitle) {
    const button = $("btn-host-subtitles");
    const menuButton = $("btn-host-subtitle-menu");
    const visible = !(hostRoomState && hostRoomState.active_subtitle_visible === false);
    if (button) {
        button.disabled = !subtitle;
        const on = Boolean(subtitle) && visible;
        // Only one colour class may be present: the stylesheet order between
        // slate and sky is not the order they are added in.
        button.classList.toggle("text-sky-300", on);
        button.classList.toggle("text-slate-200", !on);
        button.setAttribute("aria-pressed", Boolean(subtitle) && visible ? "true" : "false");
        button.title = !subtitle
            ? "当前没有字幕"
            : visible
              ? "隐藏字幕（成员跟随）"
              : "显示字幕（成员跟随）";
    }
    if (menuButton) menuButton.disabled = false;
}

function closeHostSubtitleMenu() {
    const menu = $("host-subtitle-menu");
    const button = $("btn-host-subtitle-menu");
    if (menu) menu.classList.add("hidden");
    if (button) button.setAttribute("aria-expanded", "false");
}

function toggleHostSubtitleMenu() {
    const menu = $("host-subtitle-menu");
    const button = $("btn-host-subtitle-menu");
    if (!menu || !button) return;
    const open = menu.classList.toggle("hidden") === false;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderHostSubtitleMenu(hostActiveSubtitle(), true);
}

function chooseHostSubtitle(subtitleId) {
    closeHostSubtitleMenu();
    hostSubtitleMenuSignature = "";
    // The host's pick is the room's pick: members follow it unless they chose
    // a track of their own.
    sendHostSubtitleSelect(subtitleId || null, true);
}

function renderHostSubtitleMenu(active, force) {
    const menu = $("host-subtitle-menu");
    if (!menu) return;
    const options = subtitleListOf(hostRoomState);
    const signature = [options.map((item) => item.subtitle_id).join(","), active ? active.subtitle_id : ""].join("|");
    if (!force && signature === hostSubtitleMenuSignature) return;
    hostSubtitleMenuSignature = signature;

    menu.textContent = "";
    if (!options.length) {
        const empty = document.createElement("div");
        empty.className = "px-2.5 py-1.5 text-[11px] text-slate-500";
        empty.textContent = "当前视频没有可选字幕";
        menu.appendChild(empty);
        return;
    }
    menu.appendChild(subtitleMenuOption(!active, "关闭字幕", "", () => chooseHostSubtitle(null)));
    for (const item of options) {
        const selected = Boolean(active) && active.subtitle_id === item.subtitle_id;
        menu.appendChild(
            subtitleMenuOption(selected, item.name || item.lang || "字幕", selected ? "播放中" : "", () =>
                chooseHostSubtitle(item.subtitle_id)
            )
        );
    }
}

function renderHostSubtitles(force) {
    const active = hostActiveSubtitle();
    updateHostSubtitleButton(active);
    renderHostSubtitleMenu(active, force);
    applyHostVideoSubtitle();
}

function applyHostVideoSubtitle() {
    const video = $("host-video");
    if (!video) return;
    const subtitle = findActiveSubtitle(hostRoomState);
    const visible = !(hostRoomState && hostRoomState.active_subtitle_visible === false);
    if (!subtitle) {
        removeSubtitleTracks(video);
        return;
    }
    const track = video.querySelector(SUBTITLE_TRACK_SELECTOR);
    if (!track || track.dataset.subtitleId !== subtitle.subtitle_id) {
        addSubtitleTrack(video, subtitle, visible);
    } else {
        setSubtitleTrackMode(video, visible);
    }
}

function applyHostRoomState(roomState) {
    if (!roomState || typeof roomState !== "object") return;
    const ts = Number(roomState.server_ts) || 0;
    if (ts && ts < hostRoomStateTs) return;
    if (ts) hostRoomStateTs = ts;
    hostRoomState = roomState;
    noteStream(roomState, roomState.media_url);
    if (Array.isArray(roomState.members)) updateHostMembers(roomState.members);
    if (Array.isArray(roomState.playlist)) setHostPlaylist(roomState.playlist);
    updateHostMediaLabel(roomState.media);
    renderHostSubtitles();
    followHostStream();
}

// A restart means the old stream is finished: load the new one and pick the
// host's own position back up.  Anything else just refreshes the clock offset.
function followHostStream() {
    const host = state.host;
    const media = hostRoomState && hostRoomState.media;
    if (!host || !media || media.playback_mode !== "hls") return;
    const epoch = roomMediaEpoch();
    const fresh = !host.isHls || (hostAttachedEpoch >= 0 && epoch !== hostAttachedEpoch);
    if (!fresh) {
        hostAttachedEpoch = epoch;
        host.setHlsStart(roomMediaStart());
        return;
    }
    const wasPlaying = host.isHls && !host.video.paused && !host.video.ended;
    host.switchHls(hostStream.url, {
        start: roomMediaStart(),
        duration: Number(media.duration) || 0,
    });
    hostAttachedEpoch = epoch;
    if (wasPlaying) host.play();
}

function sendHostSubtitleSelect(subtitleId, visible) {
    if (!state.host) return;
    state.host.selectSubtitle(subtitleId || null, visible !== false);
}

async function uploadHostSubtitleFile() {
    const input = $("host-subtitle-file");
    const file = input && input.files ? input.files[0] : null;
    if (input) input.value = "";
    if (!file) return;
    if (!state.room || !state.host) {
        toast("请先创建房间", "error");
        return;
    }
    const problem = validateSubtitleFile(file);
    if (problem) {
        toast(problem, "error");
        return;
    }
    const button = $("btn-upload-subtitle");
    setButtonsBusy(button, true, "上传中…");
    try {
        await uploadSubtitle(state.room, file);
        toast(`字幕「${file.name}」已上传`, "success");
    } catch (error) {
        toast(error.message || "字幕上传失败", "error");
    } finally {
        setButtonsBusy(button, false);
    }
}

function wireHostSubtitleControls() {
    $("btn-host-subtitles").addEventListener("click", (event) => {
        event.stopPropagation();
        const active = hostActiveSubtitle();
        if (!active) return;
        const visible = !(hostRoomState && hostRoomState.active_subtitle_visible === false);
        sendHostSubtitleSelect(active.subtitle_id, !visible);
    });
    $("btn-host-subtitle-menu").addEventListener("click", (event) => {
        event.stopPropagation();
        toggleHostSubtitleMenu();
    });
    $("host-subtitle-menu").addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", () => closeHostSubtitleMenu());
    $("host-subtitle-size").addEventListener("change", (event) => {
        setSubtitleSize(event.target.value);
    });
    const uploadButton = $("btn-upload-subtitle");
    const uploadInput = $("host-subtitle-file");
    if (uploadButton && uploadInput) {
        uploadButton.addEventListener("click", () => uploadInput.click());
        uploadInput.addEventListener("change", uploadHostSubtitleFile);
    }
}

function persistHostSession() {
    try {
        sessionStorage.setItem(HOST_KEY, JSON.stringify(state.room));
    } catch {
        // ignore storage failures
    }
}

// -- host playback failures ------------------------------------------
// A file the browser cannot decode leaves a black player.  Say which codec is
// at fault and keep it on screen until the host switches to something else.
function hostPlaybackMessage(detail) {
    const code = detail && detail.code ? detail.code : 0;
    const media = (hostRoomState && hostRoomState.media) || (state.room && state.room.media) || null;
    const info = media && media.media_id ? mediaCodecInfo.get(media.media_id) : null;
    const codecHint = info && window.HallMkv ? window.HallMkv.describeUnsupported(info) : null;
    if (codecHint) return codecHint;
    if (code === 4) {
        if (media && media.kind === "url") {
            return "这个视频地址打不开，可能已失效或对方不允许读取，请检查地址后重试。";
        }
        return "浏览器无法解码这个文件。常见原因是 H.265/HEVC 视频或 AC3/DTS 音轨，建议转成 MP4（H.264 视频 + AAC 音轨）后再播放。";
    }
    if (code === 2) return "读取文件时出错，请确认文件还在原来的位置、没有被移动或删除。";
    if (code === 3) return "视频解码失败，文件可能已损坏，或者编码不被浏览器支持。";
    if (code === 1) return "播放被中止了，请重新选择这个视频试试。";
    return "浏览器加载这个文件时出错，请确认文件完整、格式可被浏览器播放。";
}

// The failure can land before the codec scan has finished; re-read the header
// and replace the generic text once we know what is really in the file.
async function refineHostError() {
    const media = (hostRoomState && hostRoomState.media) || (state.room && state.room.media) || null;
    if (!media || !media.media_id || mediaCodecInfo.has(media.media_id)) return;
    if (!window.HallMkv) return;
    const file = state.playlistFiles.get(media.media_id);
    if (!file) return;
    let header = null;
    try {
        header = await window.HallMkv.analyze(file);
    } catch (error) {
        return;
    }
    if (!header) return;
    mediaCodecInfo.set(media.media_id, header.info);
    const hint = window.HallMkv.describeUnsupported(header.info);
    const overlay = $("host-error");
    const label = $("host-error-text");
    if (!hint || !overlay || !label || overlay.classList.contains("hidden")) return;
    const current = (hostRoomState && hostRoomState.media) || (state.room && state.room.media) || null;
    if (!current || current.media_id !== media.media_id) return;
    label.textContent = hint;
}

function showHostError(text) {
    const overlay = $("host-error");
    const label = $("host-error-text");
    if (!overlay || !label) {
        toast(text, "error");
        return;
    }
    label.textContent = text;
    overlay.classList.remove("hidden");
    toast(text, "error");
}

function hideHostError() {
    const overlay = $("host-error");
    if (overlay) overlay.classList.add("hidden");
}

function startHost(session, file, room) {
    if (state.host) {
        state.host.stop();
        state.host = null;
    }
    state.role = "host";
    state.playlistFiles = new Map();
    if (file && session.media && session.media.media_id) {
        state.playlistFiles.set(session.media.media_id, file);
    }
    state.playlist = [];
    hostAttachedEpoch = -1;
    noteStream(room, room && room.media_url);
    session.media_start = hostStream.start;
    if (jellyfinPicker) jellyfinPicker.reset();

    $("host-room-name").textContent = room && room.name ? room.name : session.name;
    updateHostMediaLabel(session.media);
    $("host-room-code").textContent = session.room_code;
    $("host-position").textContent = "00:00";
    $("host-rate").textContent = "1.00x";
    $("host-buffered").textContent = "--";
    hostRoomState = room || null;
    hostRoomStateTs = 0;
    updateHostMembers(room ? room.members : []);
    setHostPlaylist((room && room.playlist) || []);
    renderHostSubtitles();
    setStatusBadge("host-status", "等待连接", "muted");
    changeView("host");

    const host = new HostController({
        video: $("host-video"),
        file,
        session,
        onStatus: (kind, detail) => {
            if (kind === "connecting") setStatusBadge("host-status", "连接中…", "warn");
            else if (kind === "connected") setStatusBadge("host-status", "已连接", "good");
            else if (kind === "reconnecting") setStatusBadge("host-status", `重连中…${detail || ""}`, "warn");
            else if (kind === "closed") setStatusBadge("host-status", "连接断开", "bad");
            else if (kind === "ended") setStatusBadge("host-status", "房间已结束", "muted");
        },
        onMembers: (members) => updateHostMembers(members),
        onRoomState: (roomState) => applyHostRoomState(roomState),
        onError: (message, detail) => {
            if (detail && detail.kind === "media") {
                showHostError(hostPlaybackMessage(detail));
                refineHostError();
            } else {
                toast(message, "error");
            }
        },
        onLoaded: () => hideHostError(),
        onEnded: () => handleHostEnded(),
        onMetrics: ({ buffered }) => {
            $("host-buffered").textContent = fmtBytes(buffered);
        },
        onProgress: ({ position, absolute, rate }) => {
            $("host-position").textContent = fmtTime(absolute === undefined ? position : absolute);
            $("host-rate").textContent = `${Number(rate || 1).toFixed(2)}x`;
        },
        onClosed: ({ fatal, code }) => {
            if (!fatal || code === 1000) return;
            toast("与服务器的连接已断开，请刷新页面后重新创建房间", "error");
        },
    });
    state.host = host;
    host.start();
    requestWakeLock();
}

async function endStoredHostSession() {
    let raw = null;
    try {
        raw = sessionStorage.getItem(HOST_KEY);
    } catch {
        return;
    }
    if (!raw) return;
    let session = null;
    try {
        session = JSON.parse(raw);
    } catch {
        session = null;
    }
    try {
        sessionStorage.removeItem(HOST_KEY);
    } catch {
        // ignore
    }
    if (!session || !session.room_id || !session.host_token) return;
    try {
        await request(`/hall/api/rooms/${encodeURIComponent(session.room_id)}`, {
            method: "DELETE",
            headers: { "X-Host-Token": session.host_token },
        });
        toast("已关闭上次未结束的房间", "info");
    } catch {
        // room may already be gone
    }
}

async function endCurrentRoom() {
    if (!state.room || !state.host) return;
    if (!window.confirm("确定结束房间吗？所有成员会立即断开。")) return;
    const session = state.room;
    const button = $("btn-end-room");
    setButtonsBusy(button, true, "正在结束…");
    try {
        await request(`/hall/api/rooms/${encodeURIComponent(session.room_id)}`, {
            method: "DELETE",
            headers: { "X-Host-Token": session.host_token },
        });
    } catch (error) {
        toast(error.message || "结束房间失败", "error");
    }
    if (state.host) {
        state.host.stop();
        state.host = null;
    }
    state.role = null;
    state.room = null;
    try {
        sessionStorage.removeItem(HOST_KEY);
    } catch {
        // ignore
    }
    window.history.replaceState({}, "", window.location.pathname);
    setButtonsBusy(button, false);
    changeView("landing");
    refreshRoomList();
    toast("房间已结束", "success");
}

// -- member ----------------------------------------------------------
function setMemberStatus(text, emphasize = false) {
    const el = $("member-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = emphasize ? "#fbbf24" : "";
    el.style.fontWeight = emphasize ? "600" : "";
}

function setMemberOverlay(key, text, actionLabel, action) {
    if (!text) overlayEntries.delete(key);
    else overlayEntries.set(key, { text, actionLabel, action });
    renderMemberOverlay();
}

function renderMemberOverlay() {
    const overlay = $("member-overlay");
    const textEl = $("member-overlay-text");
    const button = $("member-play-btn");
    if (!overlay || !textEl || !button) return;

    let entry = null;
    let chosenKey = null;
    for (const key of OVERLAY_PRIORITY) {
        if (overlayEntries.has(key)) {
            entry = overlayEntries.get(key);
            chosenKey = key;
            break;
        }
    }
    if (!entry) {
        overlay.classList.add("hidden");
        overlayAction = null;
        return;
    }
    overlay.classList.remove("hidden");
    const buffering = chosenKey === "buffering";
    const paused = chosenKey === "paused";
    overlay.classList.toggle("bg-slate-950/30", buffering);
    overlay.classList.toggle("bg-slate-950/40", paused);
    overlay.classList.toggle("bg-slate-950/85", !buffering && !paused);
    overlay.classList.toggle("backdrop-blur-sm", !buffering && !paused);
    textEl.textContent = entry.text;
    textEl.style.fontSize = paused ? "1.25rem" : "";
    textEl.style.fontWeight = paused ? "600" : "";
    textEl.style.color = paused ? "#f8fafc" : "";
    textEl.style.letterSpacing = paused ? "0.08em" : "";
    if (entry.actionLabel && typeof entry.action === "function") {
        button.textContent = entry.actionLabel;
        button.classList.remove("hidden");
        overlayAction = entry.action;
    } else {
        button.classList.add("hidden");
        overlayAction = null;
    }
}

function renderMemberPlaylist(roomState) {
    const list = $("member-playlist");
    const count = $("member-playlist-count");
    if (!list) return;
    const items = roomState && Array.isArray(roomState.playlist) ? roomState.playlist : [];
    if (count) count.textContent = `${items.length} 项`;
    list.replaceChildren();
    if (!items.length) {
        const empty = document.createElement("li");
        empty.className = "text-xs italic text-slate-600";
        empty.textContent = "房主还未添加内容";
        list.appendChild(empty);
        return;
    }
    items.forEach((item, index) => {
        const row = document.createElement("li");
        row.className =
            "flex items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-2";
        const title = document.createElement("div");
        title.className = `min-w-0 truncate text-xs ${item.active ? "font-semibold text-sky-300" : "text-slate-300"}`;
        title.textContent = `${index + 1}. ${item.name || "视频"}`;
        row.appendChild(title);
        if (item.active) {
            const badge = document.createElement("span");
            badge.className = "shrink-0 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-300";
            badge.textContent = "播放中";
            row.appendChild(badge);
        }
        list.appendChild(row);
    });
}

function updateMemberMembers(members) {
    renderMembers($("member-members"), members, {
        hostName: "房主",
        selfId: state.member && state.member.session ? state.member.session.member_id : null,
        emptyText: "房间里只有你",
    });
}

function storedSubtitleSize() {
    try {
        const value = localStorage.getItem(SUBTITLE_SIZE_KEY);
        if (["small", "medium", "large"].includes(value)) return value;
    } catch {
        // ignore
    }
    return "medium";
}

function setSubtitleSize(size) {
    const chosen = ["small", "medium", "large"].includes(size) ? size : "medium";
    // Both players share one preference: the host watches the same video, so a
    // size that differs between the two views just looks broken when switching.
    for (const id of ["host-video", "member-video"]) {
        const video = $(id);
        if (!video) continue;
        video.classList.remove(...SUBTITLE_SIZE_CLASSES);
        video.classList.add(`cue-${chosen}`);
    }
    for (const id of ["host-subtitle-size", "member-subtitle-size"]) {
        const select = $(id);
        if (select) select.value = chosen;
    }
    try {
        localStorage.setItem(SUBTITLE_SIZE_KEY, chosen);
    } catch {
        // ignore
    }
}

// -- wide mode -------------------------------------------------------
// A page-level layout switch rather than fullscreen: the player takes the
// whole window and the accessory cards below fold away. Remembered per browser.
function storedWideMode() {
    try {
        return localStorage.getItem(WIDE_MODE_KEY) === "1";
    } catch {
        return false;
    }
}

function applyWideMode() {
    // The landing page keeps its card grid; only the two player views stretch.
    const inRoom = ["view-host", "view-member"].some((id) => {
        const view = $(id);
        return view && !view.classList.contains("hidden");
    });
    const on = wideMode && inRoom;
    document.body.classList.toggle("hall-wide", on);
    for (const id of ["btn-wide-mode", "btn-wide-mode-member"]) {
        const button = $(id);
        if (!button) continue;
        button.setAttribute("aria-pressed", on ? "true" : "false");
        button.classList.toggle("text-sky-300", on);
        button.classList.toggle("text-slate-200", !on);
        button.title = on
            ? "退出宽屏，恢复常规排版（ESC）"
            : "宽屏：播放器铺满窗口，隐藏下方卡片（ESC 退出）";
    }
}

function toggleWideMode() {
    wideMode = !wideMode;
    try {
        localStorage.setItem(WIDE_MODE_KEY, wideMode ? "1" : "0");
    } catch {
        // ignore
    }
    applyWideMode();
}

function changeView(name) {
    showView(name);
    applyWideMode();
}

function updateMemberSubtitleButton(subtitle) {
    const button = $("btn-member-subtitles");
    const menuButton = $("btn-member-subtitle-menu");
    const override = Boolean(memberSubtitleChoice);
    if (button) {
        button.disabled = !subtitle;
        const on = Boolean(subtitle) && memberSubtitlesVisible;
        button.classList.toggle("text-sky-300", on);
        button.classList.toggle("text-slate-200", !on);
        button.setAttribute("aria-pressed", memberSubtitlesVisible ? "true" : "false");
        button.title = !subtitle
            ? "当前没有字幕"
            : memberSubtitlesVisible
              ? "隐藏字幕（仅本机生效）"
              : "显示字幕（仅本机生效）";
    }
    if (menuButton) {
        menuButton.disabled = false;
        menuButton.classList.toggle("text-sky-300", override);
        menuButton.classList.toggle("text-slate-200", !override);
        menuButton.title = override ? "正在使用本机选择的字幕" : "选择字幕（仅本机生效）";
    }
}

// The subtitle this viewer is actually seeing: their own pick, or the room's.
function memberEffectiveSubtitle(roomState) {
    const options = subtitleListOf(roomState);
    if (memberSubtitleChoice) {
        return options.find((item) => item.subtitle_id === memberSubtitleChoice) || null;
    }
    const activeId = (roomState && roomState.active_subtitle_id) || null;
    return options.find((item) => item.subtitle_id === activeId) || null;
}

function closeMemberSubtitleMenu() {
    const menu = $("member-subtitle-menu");
    const button = $("btn-member-subtitle-menu");
    if (menu) menu.classList.add("hidden");
    if (button) button.setAttribute("aria-expanded", "false");
}

function toggleMemberSubtitleMenu() {
    const menu = $("member-subtitle-menu");
    const button = $("btn-member-subtitle-menu");
    if (!menu || !button) return;
    const open = menu.classList.toggle("hidden") === false;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderMemberSubtitleMenu(memberRoomState, memberEffectiveSubtitle(memberRoomState), true);
}

function chooseMemberSubtitle(subtitleId) {
    memberSubtitleChoice = subtitleId || null;
    if (!memberSubtitleChoice) {
        // Back to following the room: pick its choice back up as-is.
        memberSubtitlesVisible = memberSubtitleHostVisible;
    } else {
        memberSubtitlesVisible = true;
    }
    closeMemberSubtitleMenu();
    memberSubtitleMenuSignature = "";
    applyMemberSubtitles(memberRoomState);
}

function subtitleMenuOption(selected, label, note, onPick) {
    const item = document.createElement("button");
    item.className =
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition hover:bg-white/10 " +
        (selected ? "text-sky-300" : "text-slate-300");
    const name = document.createElement("span");
    name.className = "truncate";
    name.textContent = label;
    item.appendChild(name);
    if (note) {
        const badge = document.createElement("span");
        badge.className = "shrink-0 rounded bg-white/10 px-1 py-0.5 text-[9px] text-slate-400";
        badge.textContent = note;
        item.appendChild(badge);
    }
    item.addEventListener("click", (event) => {
        event.stopPropagation();
        onPick();
    });
    return item;
}

function renderMemberSubtitleMenu(roomState, effective, force) {
    const menu = $("member-subtitle-menu");
    if (!menu) return;
    const options = subtitleListOf(roomState);
    const hostActiveId = (roomState && roomState.active_subtitle_id) || null;
    const signature = [
        options.map((item) => item.subtitle_id).join(","),
        memberSubtitleChoice || "",
        hostActiveId || "",
        effective ? effective.subtitle_id : "",
    ].join("|");
    if (!force && signature === memberSubtitleMenuSignature) return;
    memberSubtitleMenuSignature = signature;

    menu.textContent = "";
    if (!options.length) {
        const empty = document.createElement("div");
        empty.className = "px-2.5 py-1.5 text-[11px] text-slate-500";
        empty.textContent = "当前视频没有可选字幕";
        menu.appendChild(empty);
        return;
    }
    menu.appendChild(
        subtitleMenuOption(
            !memberSubtitleChoice,
            "跟随房主",
            null,
            () => chooseMemberSubtitle(null)
        )
    );
    for (const item of options) {
        const selected = Boolean(effective && effective.subtitle_id === item.subtitle_id);
        const label = item.name || item.lang || "字幕";
        const note = item.subtitle_id === hostActiveId ? "房主" : null;
        menu.appendChild(
            subtitleMenuOption(selected, label, note, () =>
                chooseMemberSubtitle(item.subtitle_id)
            )
        );
    }
}

function applyMemberSubtitles(roomState) {
    const video = $("member-video");
    if (!roomState || typeof roomState !== "object") return;
    const options = subtitleListOf(roomState);
    const hostActiveId = roomState.active_subtitle_id || null;
    const hostVisible = roomState.active_subtitle_visible !== false;
    if (
        memberSubtitleChoice &&
        !options.some((item) => item.subtitle_id === memberSubtitleChoice)
    ) {
        // That track is gone: the playlist moved on or the host removed it.
        memberSubtitleChoice = null;
        memberSubtitleHostId = undefined; // force a visibility resync below
    }
    if (hostActiveId !== memberSubtitleHostId || hostVisible !== memberSubtitleHostVisible) {
        if (!memberSubtitleChoice) memberSubtitlesVisible = hostVisible;
        memberSubtitleHostId = hostActiveId;
        memberSubtitleHostVisible = hostVisible;
    }

    const subtitle = memberEffectiveSubtitle(roomState);
    if (!subtitle) {
        removeSubtitleTracks(video);
    } else {
        const track = video ? video.querySelector(SUBTITLE_TRACK_SELECTOR) : null;
        if (!track || track.dataset.subtitleId !== subtitle.subtitle_id) {
            addSubtitleTrack(video, subtitle, memberSubtitlesVisible);
        } else {
            setSubtitleTrackMode(video, memberSubtitlesVisible);
        }
    }
    updateMemberSubtitleButton(subtitle);
    renderMemberSubtitleMenu(roomState, subtitle, false);
}

function correctMemberNow() {
    const controller = state.member && state.member.controller;
    if (!controller || !controller.correctNow()) {
        toast("同步信息尚未就绪，请稍后再试", "info");
        return;
    }
    toast("已校正到目标位置", "success");
}

function toggleMemberSubtitles() {
    if (!memberRoomState || !memberEffectiveSubtitle(memberRoomState)) return;
    memberSubtitlesVisible = !memberSubtitlesVisible;
    setSubtitleTrackMode($("member-video"), memberSubtitlesVisible);
    applyMemberSubtitles(memberRoomState);
}

function startMember(session, room) {
    if (state.member) {
        state.member.destroy();
        state.member = null;
    }
    state.role = "member";
    state.member = { session, controller: null };
    overlayEntries.clear();
    memberRoomState = room || null;
    memberRoomStateTs = 0;
    memberSubtitleChoice = null;
    memberSubtitleHostId = null;
    memberSubtitleHostVisible = true;
    memberSubtitleMenuSignature = "";
    memberSubtitlesVisible = true;
    removeSubtitleTracks($("member-video"));
    setSubtitleSize(storedSubtitleSize());
    updateMemberSubtitleButton(null);

    $("member-room-name").textContent = (room && room.name) || session.room_name || "媒体播放厅";
    $("member-room-code").textContent = session.room_code;
    $("member-rtt").textContent = "--";
    $("member-drift").textContent = "--";
    $("member-d").textContent = "0.5s";
    $("member-rate").textContent = "1.00x";
    setStatusBadge("member-host-badge", "连接中", "muted");
    setMemberStatus("正在连接房间…");
    if (room) {
        updateMemberMembers(room.members || []);
        renderMemberPlaylist(room);
        if (!room.media) setMemberStatus("等待房主添加内容…");
        if (room.host && room.host.online !== false) {
            setStatusBadge("member-host-badge", "房主在线", "good");
        }
        applyMemberSubtitles(room);
    }
    changeView("member");
    setMemberOverlay("connecting", "正在连接房间…", null, null);

    const controller = new MemberController({
        video: $("member-video"),
        session,
        onOverlay: (key, text, actionLabel, action) => setMemberOverlay(key, text, actionLabel, action),
        onRoomState: (roomState) => {
            if (roomState && roomState.name) $("member-room-name").textContent = roomState.name;
            const hostOnline = roomState && roomState.host && roomState.host.online !== false;
            const hostPaused = hostOnline && roomState.host && !roomState.host.playing;
            setStatusBadge(
                "member-host-badge",
                hostOnline ? (hostPaused ? "房主已暂停" : "房主在线") : "房主离线",
                hostOnline ? (hostPaused ? "warn" : "good") : "bad"
            );
            const ts = Number(roomState && roomState.server_ts) || 0;
            if (ts && ts < memberRoomStateTs) return;
            if (ts) memberRoomStateTs = ts;
            memberRoomState = roomState || null;
            renderMemberPlaylist(roomState);
            applyMemberSubtitles(roomState);
        },
        onHostState: (host) => {
            const online = host.online !== false;
            const paused = online && !host.playing;
            setStatusBadge(
                "member-host-badge",
                online ? (paused ? "房主已暂停" : "房主在线") : "房主离线",
                online ? (paused ? "warn" : "good") : "bad"
            );
            if (!online) {
                setMemberStatus("房主已离线，等待重新连接…");
                setMemberOverlay("paused", null, null, null);
            } else if (!memberRoomState || !memberRoomState.media) {
                setMemberStatus("等待房主添加内容…");
                setMemberOverlay("paused", null, null, null);
            } else if (host.playing) {
                setMemberStatus(host.buffering ? "房主正在缓冲…" : "跟随房主播放中");
                setMemberOverlay("paused", null, null, null);
            } else {
                setMemberStatus("房主已暂停", true);
                setMemberOverlay("paused", "房主已暂停", null, null);
            }
        },
        onMembers: (members) => updateMemberMembers(members),
        onConnected: () => {
            setMemberStatus("已连接，正在同步…");
        },
        onDisconnected: (message, fatal) => {
            if (fatal) {
                setStatusBadge("member-host-badge", "连接断开", "bad");
                setMemberStatus(message || "连接已断开");
            } else {
                setStatusBadge("member-host-badge", "重连中", "warn");
                setMemberStatus(message || "连接中断，正在重连…");
            }
        },
        onError: (message) => toast(message, "error"),
        onStats: (stats) => {
            $("member-rtt").textContent = stats.rtt ? `${Math.round(stats.rtt)}ms` : "--";
            $("member-drift").textContent = `${stats.drift >= 0 ? "+" : ""}${stats.drift.toFixed(2)}s`;
            $("member-d").textContent = `${stats.d.toFixed(1)}s`;
            $("member-rate").textContent = `${stats.rate.toFixed(2)}x`;
        },
        onEnded: () => {
            setStatusBadge("member-host-badge", "已结束", "muted");
            setMemberStatus("房间已结束");
        },
        onTokenInvalid: () => {
            try {
                sessionStorage.removeItem(memberKey(session.room_code));
            } catch {
                // ignore
            }
        },
        onMediaChanged: (media) => {
            const current = state.member && state.member.session;
            if (current) saveMemberSession(current);
            setMemberStatus("房主已切换视频，等待播放");
            toast(`房主已切换视频：${media.name || "新视频"}`, "info");
        },
    });
    state.member.controller = controller;
    controller.start();
}

// -- wake lock -------------------------------------------------------
let wakeLock = null;

async function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
            wakeLock = null;
        });
    } catch {
        // denied or unsupported
    }
}

// -- wiring ----------------------------------------------------------
function wire() {
    $("btn-create").addEventListener("click", createRoom);
    $("btn-join").addEventListener("click", joinRoom);
    $("btn-end-room").addEventListener("click", endCurrentRoom);
    for (const id of ["btn-wide-mode", "btn-wide-mode-member"]) {
        const button = $(id);
        if (button) button.addEventListener("click", toggleWideMode);
    }
    // Escape leaves wide mode; fullscreen swallows it there, which is fine.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !document.body.classList.contains("hall-wide")) return;
        toggleWideMode();
    });
    wireHostSubtitleControls();
    const addMediaInput = $("host-media-files");
    const addUrlRow = $("host-add-url");
    const addUrlInput = $("host-url-input");
    const addUrlHint = $("host-url-hint");
    const showUrlRow = (show) => {
        addUrlRow.classList.toggle("hidden", !show);
        addUrlRow.classList.toggle("flex", show);
        addUrlHint.classList.toggle("hidden", !show);
        if (show) addUrlInput.focus();
    };
    if (addMediaInput) {
        $("btn-add-file").addEventListener("click", () => {
            showUrlRow(false);
            jellyfin().showLogin(false);
            addMediaInput.click();
        });
        $("btn-add-url").addEventListener("click", () => {
            showUrlRow(false);
            jellyfin().showLogin(false);
            showUrlRow(true);
        });
        $("btn-add-jellyfin")?.addEventListener("click", () => {
            showUrlRow(false);
            jellyfin().begin();
        });
        addMediaInput.addEventListener("change", () => {
            const files = Array.from(addMediaInput.files || []);
            addMediaInput.value = "";
            if (files.length) addHostFiles(files);
        });
        $("btn-submit-url").addEventListener("click", addHostUrl);
        $("btn-cancel-url").addEventListener("click", () => {
            addUrlInput.value = "";
            showUrlRow(false);
        });
        addUrlInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addHostUrl();
            } else if (event.key === "Escape") {
                addUrlInput.value = "";
                showUrlRow(false);
            }
        });
    }
    const autoplayBox = $("host-autoplay");
    if (autoplayBox) {
        try {
            if (localStorage.getItem(AUTOPLAY_KEY) === "0") autoplayBox.checked = false;
        } catch {
            // ignore storage failures
        }
        autoplayBox.addEventListener("change", () => {
            try {
                localStorage.setItem(AUTOPLAY_KEY, autoplayBox.checked ? "1" : "0");
            } catch {
                // ignore storage failures
            }
        });
    }
    $("btn-refresh-rooms").addEventListener("click", refreshRoomList);
    $("btn-sync-correct").addEventListener("click", correctMemberNow);
    $("btn-member-subtitles").addEventListener("click", toggleMemberSubtitles);
    $("btn-member-subtitle-menu").addEventListener("click", (event) => {
        event.stopPropagation();
        toggleMemberSubtitleMenu();
    });
    $("member-subtitle-menu").addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", () => closeMemberSubtitleMenu());
    $("member-subtitle-size").addEventListener("change", (event) => {
        setSubtitleSize(event.target.value);
    });
    $("btn-copy-link").addEventListener("click", async () => {
        if (!state.room) return;
        const link = shareLink(state.room.room_code);
        const ok = await copyText(link);
        toast(ok ? "分享链接已复制" : link, ok ? "success" : "info");
    });
    $("member-play-btn").addEventListener("click", () => {
        if (typeof overlayAction === "function") {
            try {
                overlayAction();
            } catch {
                toast("操作失败，请重试", "error");
            }
        }
    });
    $("join-code").addEventListener("keydown", (event) => {
        if (event.key === "Enter") joinRoom();
    });
    $("join-name").addEventListener("keydown", (event) => {
        if (event.key === "Enter") joinRoom();
    });

    // Unmuting restores the last audible level: a slider dragged to 0 leaves the
    // element silent even after the mute flag is cleared.
    let memberVolume = 1;
    const syncMemberMute = () => {
        const video = $("member-video");
        $("btn-mute").classList.toggle("text-rose-300", video.muted || video.volume === 0);
    };
    $("btn-mute").addEventListener("click", () => {
        const video = $("member-video");
        if (video.muted || video.volume === 0) {
            video.muted = false;
            if (video.volume === 0) video.volume = memberVolume || 1;
            $("member-volume").value = String(Math.round(video.volume * 100));
        } else {
            video.muted = true;
            $("member-volume").value = "0";
        }
        syncMemberMute();
    });
    $("member-volume").addEventListener("input", (event) => {
        const video = $("member-video");
        const value = Number(event.target.value) / 100;
        video.volume = value;
        video.muted = value === 0;
        if (value > 0) memberVolume = value;
        syncMemberMute();
    });
    // Up/down set this viewer's own volume.  It never leaves the tab, so it is
    // safe to offer where seeking is not.
    const memberHint = $("member-key-hint");
    let memberHintTimer = 0;
    const flashMemberHint = (text) => {
        if (!memberHint) return;
        memberHint.textContent = text;
        memberHint.classList.remove("hidden");
        clearTimeout(memberHintTimer);
        memberHintTimer = window.setTimeout(() => memberHint.classList.add("hidden"), 700);
    };
    document.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if ($("view-member").classList.contains("hidden")) return;
        const target = event.target;
        if (target && target.closest && target.closest("input, textarea, select, button, [contenteditable='true']")) return;
        const video = $("member-video");
        if (!video.getAttribute("src")) return;
        event.preventDefault();
        const from = video.muted ? 0 : video.volume;
        const next = Math.min(1, Math.max(0, Number((from + (event.key === "ArrowUp" ? 0.1 : -0.1)).toFixed(2))));
        video.volume = next;
        video.muted = next === 0;
        if (next > 0) memberVolume = next;
        $("member-volume").value = String(Math.round(next * 100));
        syncMemberMute();
        flashMemberHint(next === 0 ? "静音" : `音量 ${Math.round(next * 100)}%`);
    });

    $("btn-fullscreen").addEventListener("click", async () => {
        const shell = $("member-shell");
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await shell.requestFullscreen();
        } catch {
            toast("当前浏览器不支持全屏", "error");
        }
    });

    // Picture-in-picture is a local view option on both sides: it never changes
    // what the room plays, so members get it too.
    const wirePictureInPicture = (video, button) => {
        if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== "function") {
            button.classList.add("hidden");
            return;
        }
        const sync = () => button.classList.toggle("text-sky-300", document.pictureInPictureElement === video);
        button.addEventListener("click", async () => {
            try {
                if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
                else await video.requestPictureInPicture();
            } catch {
                toast("当前视频无法进入浮窗", "error");
            }
            sync();
        });
        video.addEventListener("enterpictureinpicture", sync);
        video.addEventListener("leavepictureinpicture", sync);
        sync();
    };
    wirePictureInPicture($("member-video"), $("btn-pip"));

    // Members are read-only, but they still want to see where the room is: the
    // bar shows a plain progress track instead of a draggable slider.
    (() => {
        const video = $("member-video");
        const fill = $("member-progress-fill");
        const line = $("member-progress-line");
        const bar = $("member-progress");
        const current = $("member-current");
        const duration = $("member-duration");
        const sync = () => {
            const controller = state.member && state.member.controller;
            // A transcoded stream's clock starts where the transcode started,
            // so the bar shows item time rather than stream time.
            const offset = controller && controller.isHls ? controller.timeOffset : 0;
            const total =
                controller && controller.isHls && controller.mediaDuration > 0
                    ? controller.mediaDuration
                    : Number.isFinite(video.duration)
                      ? video.duration
                      : 0;
            const position = (Number(video.currentTime) || 0) + offset;
            const percent = total > 0 ? Math.min(100, Math.max(0, (position / total) * 100)) : 0;
            fill.style.width = `${percent.toFixed(2)}%`;
            line.style.width = `${percent.toFixed(2)}%`;
            bar.setAttribute("aria-valuenow", String(Math.round(percent)));
            current.textContent = fmtTime(position);
            duration.textContent = fmtTime(total);
        };
        for (const name of ["timeupdate", "loadedmetadata", "durationchange", "emptied", "seeked", "ended"]) {
            video.addEventListener(name, sync);
        }
        sync();
    })();

    // The host video has no native controls: it uses the same bar as members.
    (() => {
        const video = $("host-video");
        const playButton = $("btn-host-play");
        const playIcon = $("host-play-icon");
        const pauseIcon = $("host-pause-icon");
        const seek = $("host-seek");
        const volume = $("host-volume");
        const muteButton = $("btn-host-mute");
        let scrubbing = false;
        let lastVolume = 1;

        const syncIcon = () => {
            const playing = !video.paused && !video.ended;
            playIcon.classList.toggle("hidden", playing);
            pauseIcon.classList.toggle("hidden", !playing);
            playButton.title = playing ? "暂停" : "播放";
        };
        const syncVolumeIcon = () => {
            muteButton.classList.toggle("text-rose-300", video.muted || video.volume === 0);
        };
        // The slider works in item time.  For a transcode that is the element
        // clock plus wherever the stream started, which the controller owns.
        const hostClock = () => {
            const host = state.host;
            if (host) return { position: host.absoluteTime(), duration: host.effectiveDuration() };
            return {
                position: video.currentTime || 0,
                duration: Number.isFinite(video.duration) ? video.duration : 0,
            };
        };
        const syncTimeline = () => {
            const { position, duration } = hostClock();
            seek.max = String(duration || 0);
            if (!scrubbing) seek.value = String(position || 0);
            $("host-current").textContent = fmtTime(position || 0);
            $("host-duration").textContent = fmtTime(duration);
        };

        $("host-error-close")?.addEventListener("click", () => hideHostError());

        // Left/right scrub the timeline and up/down set the volume.  A seek
        // reaches members through the usual "seeked" broadcast; volume stays
        // local to this tab.
        const keyHint = $("host-key-hint");
        let keyHintTimer = 0;
        const flashHint = (text) => {
            if (!keyHint) return;
            keyHint.textContent = text;
            keyHint.classList.remove("hidden");
            clearTimeout(keyHintTimer);
            keyHintTimer = window.setTimeout(() => keyHint.classList.add("hidden"), 700);
        };
        const seekTo = (target) => {
            if (!state.host) return;
            if (state.host.isHls) {
                // A transcoded stream cannot be scrubbed locally: the server
                // restarts it at the new position and everyone follows.
                requestHlsSeek(target);
                return;
            }
            try {
                video.currentTime = target;
            } catch {
                // ignore
            }
            syncTimeline();
        };
        const seekBy = (seconds) => {
            const { position, duration } = hostClock();
            if (!duration) return;
            const next = Math.min(Math.max((position || 0) + seconds, 0), duration);
            seekTo(next);
            flashHint(seconds < 0 ? `回退 ${Math.abs(seconds)} 秒` : `快进 ${seconds} 秒`);
        };
        const setVolumeBy = (step) => {
            // Raising the volume always unmutes: otherwise the first press
            // would appear to do nothing.
            const from = video.muted ? 0 : video.volume;
            const next = Math.min(1, Math.max(0, Number((from + step).toFixed(2))));
            video.volume = next;
            video.muted = next === 0;
            if (next > 0) lastVolume = next;
            volume.value = String(Math.round(next * 100));
            syncVolumeIcon();
            flashHint(next === 0 ? "静音" : `音量 ${Math.round(next * 100)}%`);
        };
        document.addEventListener("keydown", (event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (!state.host || $("view-host").classList.contains("hidden")) return;
            const target = event.target;
            // Leaves the volume/seek sliders and any text field to their own keys.
            if (target && target.closest && target.closest("input, textarea, select, button, [contenteditable='true']")) return;
            if (!video.getAttribute("src")) return;
            event.preventDefault();
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                setVolumeBy(event.key === "ArrowUp" ? 0.1 : -0.1);
                return;
            }
            seekBy(event.key === "ArrowRight" ? 5 : -5);
        });

        playButton.addEventListener("click", () => {
            if (!state.host) return;
            if (video.paused || video.ended) state.host.play();
            else video.pause();
        });
        seek.addEventListener("input", () => {
            scrubbing = true;
            $("host-current").textContent = fmtTime(Number(seek.value) || 0);
        });
        seek.addEventListener("change", () => {
            const target = Number(seek.value) || 0;
            scrubbing = false;
            const { duration } = hostClock();
            seekTo(duration ? Math.min(target, duration) : target);
            syncTimeline();
        });
        muteButton.addEventListener("click", () => {
            if (video.muted || video.volume === 0) {
                video.muted = false;
                if (video.volume === 0) video.volume = lastVolume || 1;
                volume.value = String(Math.round(video.volume * 100));
            } else {
                video.muted = true;
                volume.value = "0";
            }
            syncVolumeIcon();
        });
        volume.addEventListener("input", (event) => {
            const value = Number(event.target.value) / 100;
            video.volume = value;
            video.muted = value === 0;
            if (value > 0) lastVolume = value;
            syncVolumeIcon();
        });
        $("btn-host-fullscreen").addEventListener("click", async () => {
            const shell = $("host-shell");
            try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await shell.requestFullscreen();
            } catch {
                toast("当前浏览器不支持全屏", "error");
            }
        });

        // Playback rate: the host sets the pace and members follow through the
        // host timeline, so only this bar carries the control.
        const rateButton = $("btn-host-rate");
        const rateMenu = $("host-rate-menu");
        const rateLabel = $("host-rate-label");
        const rateOptions = Array.from(rateMenu.querySelectorAll("[data-rate]"));
        const syncRate = () => {
            const rate = Number(video.playbackRate) || 1;
            rateLabel.textContent = `${Number(rate.toFixed(2))}x`;
            for (const option of rateOptions) {
                const active = Math.abs(Number(option.dataset.rate) - rate) < 0.001;
                option.classList.toggle("text-sky-300", active);
                option.classList.toggle("font-bold", active);
            }
        };
        rateButton.addEventListener("click", (event) => {
            event.stopPropagation();
            rateMenu.classList.toggle("hidden");
        });
        for (const option of rateOptions) {
            option.addEventListener("click", () => {
                const rate = Number(option.dataset.rate) || 1;
                video.playbackRate = rate;
                // A new source resets playbackRate to defaultPlaybackRate, so the
                // chosen speed has to live there to survive playlist switches.
                video.defaultPlaybackRate = rate;
                rateMenu.classList.add("hidden");
                syncRate();
            });
        }
        document.addEventListener("click", () => rateMenu.classList.add("hidden"));
        video.addEventListener("ratechange", syncRate);

        wirePictureInPicture(video, $("btn-host-pip"));

        for (const name of ["play", "pause", "ended", "loadedmetadata", "durationchange", "seeking"]) {
            video.addEventListener(name, syncIcon);
        }
        for (const name of ["timeupdate", "loadedmetadata", "durationchange", "seeked"]) {
            video.addEventListener(name, syncTimeline);
        }
        video.addEventListener("volumechange", syncVolumeIcon);
        syncIcon();
        syncTimeline();
        syncVolumeIcon();
        syncRate();
    })();

    window.addEventListener("beforeunload", (event) => {
        if (state.role === "host" && state.host) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (state.role === "host") requestWakeLock();
        else if (!state.role) refreshRoomList();
    });
}

function installDebugHook() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("debug")) return;
    window.__hallDebug = () => {
        const member = state.member && state.member.controller;
        const sync = member && member.sync;
        const video = $("member-video");
        return {
            role: state.role,
            now: Date.now(),
            rtt: sync ? sync.rtt : null,
            offset: sync ? sync.offset : null,
            serverNow: sync && sync.offsetValid ? sync.serverNow() : null,
            host: sync ? sync.host : null,
            D: sync ? sync.D : null,
            target: sync ? sync.targetPosition() : null,
            videoTime: video ? video.currentTime : null,
            paused: video ? video.paused : null,
            readyState: video ? video.readyState : null,
        };
    };
}

async function restoreFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const code = (params.get("room") || "").trim().toUpperCase();
    if (!code) return false;

    $("join-code").value = code;
    const stored = readMemberSession(code);
    if (!stored || !stored.member_token) return false;

    try {
        const info = await request(`/hall/api/rooms/${encodeURIComponent(code)}`);
        if (info.ended) {
            sessionStorage.removeItem(memberKey(code));
            return false;
        }
        startMember(stored, info);
        return true;
    } catch {
        try {
            sessionStorage.removeItem(memberKey(code));
        } catch {
            // ignore
        }
        return false;
    }
}

async function init() {
    wire();
    setSubtitleSize(storedSubtitleSize());
    wideMode = storedWideMode();
    installDebugHook();

    try {
        const name = localStorage.getItem("hall_member_name");
        if (name) $("join-name").value = name;
    } catch {
        // ignore
    }

    const restored = await restoreFromUrl();
    if (restored) return;

    await endStoredHostSession();
    await refreshRoomList();
    startRoomListPolling();
}

init();
