/**
 * Media hall page controller: landing actions, room creation/join, view
 * switching and the small amount of chrome around the two player modes.
 */

import { HostController } from "./host.js";
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
const MAX_PLAYLIST_ITEMS = 100;
const AUTOPLAY_KEY = "hall_autoplay";
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const SUBTITLE_TRACK_FLAG = "hallSubtitle";
const SUBTITLE_TRACK_SELECTOR = "track[data-hall-subtitle]";
const SUBTITLE_SIZE_KEY = "hall_subtitle_size";
const SUBTITLE_SIZE_CLASSES = ["cue-small", "cue-medium", "cue-large"];

let hostRoomState = null;
let hostRoomStateTs = 0;
let memberRoomState = null;
let memberRoomStateTs = 0;
let memberSubtitlesVisible = true;
let memberSubtitleTrackId = null;
let memberSubtitleHostVisible = true;

const state = {
    kind: "host_file",
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

async function uploadSubtitle(session, file) {
    const params = new URLSearchParams({ name: file.name, lang: subtitleLang(file.name) });
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
function setKind(kind) {
    state.kind = kind;
    const fileButton = $("media-kind-file");
    const urlButton = $("media-kind-url");
    const active = "kind-btn rounded-xl border border-sky-500/60 bg-sky-500/10 px-4 py-3 text-left text-sm font-semibold text-sky-300";
    const inactive = "kind-btn rounded-xl border border-slate-700/60 bg-slate-900/40 px-4 py-3 text-left text-sm font-semibold text-slate-400";
    fileButton.className = kind === "host_file" ? active : inactive;
    urlButton.className = kind === "url" ? active : inactive;
    $("file-fields").classList.toggle("hidden", kind !== "host_file");
    $("url-fields").classList.toggle("hidden", kind !== "url");
    showError("create-error", "");
}

function validateHostFile(file) {
    if (!file) return "没有选择文件";
    if (!isLikelyVideo(file)) return "请选择浏览器可播放的视频文件（mp4 / webm / mov 等）";
    if (file.size <= 0) return "文件为空，无法播放";
    if (file.size > MAX_HOST_FILE_BYTES) return "文件超过 64GB，暂不支持";
    return null;
}

async function createRoom() {
    showError("create-error", "");
    const name = ($("create-name").value || "").trim() || "媒体播放厅";
    const subtitleInput = $("create-subtitle");
    const subtitleFile = subtitleInput && subtitleInput.files ? subtitleInput.files[0] : null;
    let media = null;
    let files = [];

    if (state.kind === "host_file") {
        files = Array.from(($("create-file").files || []));
        if (files.length > MAX_PLAYLIST_ITEMS) {
            showError("create-error", `一次最多添加 ${MAX_PLAYLIST_ITEMS} 个视频`);
            return;
        }
        for (const file of files) {
            const problem = validateHostFile(file);
            if (problem) {
                showError("create-error", `${file.name}：${problem}`);
                return;
            }
        }
        // Choosing files is optional: an empty room can be filled later.
        const first = files[0] || null;
        if (first) {
            media = {
                kind: "host_file",
                name: first.name,
                size: first.size,
                mime: first.type || "application/octet-stream",
            };
        }
    } else {
        const url = ($("create-url").value || "").trim();
        if (!/^https?:\/\//i.test(url)) {
            showError("create-error", "请输入 http(s) 开头的视频地址");
            return;
        }
        media = { kind: "url", name: "", url };
    }

    await endStoredHostSession();
    const button = $("btn-create");
    setButtonsBusy(button, true, "正在创建…");
    try {
        const body = { name };
        if (media) body.media = media;
        const data = await request("/hall/api/rooms", { method: "POST", body });
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
        if (subtitleInput) subtitleInput.value = "";
        const fileInput = $("create-file");
        if (fileInput) fileInput.value = "";
        startHost(session, files[0] || null, data.room);
        if (files.length > 1) addHostFiles(files.slice(1));
        if (subtitleFile) uploadInitialSubtitle(session, subtitleFile);
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
function hostMediaLabel(media) {
    return media ? `${media.name} · ${fmtBytes(media.size)}` : "播放列表为空";
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
        empty.textContent = "播放列表为空，点「添加视频」选择文件";
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
        meta.textContent = [item.active ? "播放中" : "", fmtBytes(item.size || 0)]
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
}

function switchHostToMedia(media, mediaUrl) {
    const host = state.host;
    if (!host) return;
    if (!media) {
        host.clearMedia();
        return;
    }
    if (media.kind === "url") {
        host.switchUrl(mediaUrl || state.room.media_url);
        return;
    }
    const file = state.playlistFiles.get(media.media_id);
    if (!file) {
        toast("这个文件的本地副本已丢失，请重新添加该文件", "error");
        return;
    }
    host.switchFile(file);
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

function renderHostSubtitles() {
    const select = $("host-subtitle-select");
    if (!select) return;
    const subtitles = subtitleListOf(hostRoomState);
    const activeId = (hostRoomState && hostRoomState.active_subtitle_id) || "";
    const activeVisible = !(hostRoomState && hostRoomState.active_subtitle_visible === false);

    select.replaceChildren();
    const off = document.createElement("option");
    off.value = "";
    off.textContent = subtitles.length ? "关闭字幕" : "暂无字幕";
    select.appendChild(off);
    for (const item of subtitles) {
        const option = document.createElement("option");
        option.value = item.subtitle_id;
        option.textContent = item.name || item.lang || "字幕";
        select.appendChild(option);
    }
    const current = subtitles.some((item) => item.subtitle_id === activeId) ? activeId : "";
    select.value = current;
    select.disabled = subtitles.length === 0;

    const checkbox = $("host-subtitle-visible");
    if (checkbox) {
        checkbox.checked = Boolean(current) && activeVisible;
        checkbox.disabled = !current;
    }
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
    if (Array.isArray(roomState.members)) updateHostMembers(roomState.members);
    if (Array.isArray(roomState.playlist)) setHostPlaylist(roomState.playlist);
    updateHostMediaLabel(roomState.media);
    renderHostSubtitles();
}

function sendHostSubtitleSelect(subtitleId, visible) {
    if (!state.host) return;
    state.host.selectSubtitle(subtitleId || null, visible !== false);
}

async function uploadInitialSubtitle(session, file) {
    const problem = validateSubtitleFile(file);
    if (problem) {
        toast(problem, "error");
        return;
    }
    try {
        await uploadSubtitle(session, file);
        toast(`字幕「${file.name}」已上传`, "success");
    } catch (error) {
        toast(error.message || "字幕上传失败，可稍后在房主控制区重试", "error");
    }
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
    const select = $("host-subtitle-select");
    if (select) {
        select.addEventListener("change", () => {
            sendHostSubtitleSelect(select.value || null, true);
        });
    }
    const checkbox = $("host-subtitle-visible");
    if (checkbox) {
        checkbox.addEventListener("change", () => {
            const activeId = (hostRoomState && hostRoomState.active_subtitle_id) || null;
            if (!activeId) return;
            sendHostSubtitleSelect(activeId, checkbox.checked);
        });
    }
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
    showView("host");

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
        onError: (message) => toast(message, "error"),
        onEnded: () => handleHostEnded(),
        onMetrics: ({ buffered }) => {
            $("host-buffered").textContent = fmtBytes(buffered);
        },
        onProgress: ({ position, rate }) => {
            $("host-position").textContent = fmtTime(position);
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
    showView("landing");
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

function storedMemberSubtitleSize() {
    try {
        const value = localStorage.getItem(SUBTITLE_SIZE_KEY);
        if (["small", "medium", "large"].includes(value)) return value;
    } catch {
        // ignore
    }
    return "medium";
}

function setMemberSubtitleSize(size) {
    const chosen = ["small", "medium", "large"].includes(size) ? size : "medium";
    const video = $("member-video");
    if (video) {
        video.classList.remove(...SUBTITLE_SIZE_CLASSES);
        video.classList.add(`cue-${chosen}`);
    }
    const select = $("member-subtitle-size");
    if (select) select.value = chosen;
    try {
        localStorage.setItem(SUBTITLE_SIZE_KEY, chosen);
    } catch {
        // ignore
    }
}

function updateMemberSubtitleButton(subtitle) {
    const button = $("btn-member-subtitles");
    if (!button) return;
    button.disabled = !subtitle;
    button.classList.toggle("text-sky-300", Boolean(subtitle) && memberSubtitlesVisible);
    button.setAttribute("aria-pressed", memberSubtitlesVisible ? "true" : "false");
    button.title = !subtitle
        ? "当前没有字幕"
        : memberSubtitlesVisible
          ? "隐藏字幕（仅本机生效）"
          : "显示字幕（仅本机生效）";
}

function applyMemberSubtitles(roomState) {
    const video = $("member-video");
    if (!roomState || typeof roomState !== "object") return;
    const activeId = roomState.active_subtitle_id || null;
    const hostVisible = roomState.active_subtitle_visible !== false;
    if (activeId !== memberSubtitleTrackId || hostVisible !== memberSubtitleHostVisible) {
        memberSubtitleTrackId = activeId;
        memberSubtitleHostVisible = hostVisible;
        memberSubtitlesVisible = hostVisible;
    }

    const subtitle = findActiveSubtitle(roomState);
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
    if (!memberRoomState || !findActiveSubtitle(memberRoomState)) return;
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
    memberSubtitleTrackId = null;
    memberSubtitleHostVisible = true;
    memberSubtitlesVisible = true;
    removeSubtitleTracks($("member-video"));
    setMemberSubtitleSize(storedMemberSubtitleSize());
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
    showView("member");
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
    $("media-kind-file").addEventListener("click", () => setKind("host_file"));
    $("media-kind-url").addEventListener("click", () => setKind("url"));
    $("btn-create").addEventListener("click", createRoom);
    $("btn-join").addEventListener("click", joinRoom);
    $("btn-end-room").addEventListener("click", endCurrentRoom);
    wireHostSubtitleControls();
    const addMediaButton = $("btn-add-media");
    const addMediaInput = $("host-media-files");
    if (addMediaButton && addMediaInput) {
        addMediaButton.addEventListener("click", () => addMediaInput.click());
        addMediaInput.addEventListener("change", () => {
            const files = Array.from(addMediaInput.files || []);
            addMediaInput.value = "";
            if (files.length) addHostFiles(files);
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
    $("member-subtitle-size").addEventListener("change", (event) => {
        setMemberSubtitleSize(event.target.value);
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

    $("btn-mute").addEventListener("click", () => {
        const video = $("member-video");
        video.muted = !video.muted;
        $("btn-mute").classList.toggle("text-rose-300", video.muted);
        $("member-volume").value = video.muted ? "0" : String(Math.round(video.volume * 100));
    });
    $("member-volume").addEventListener("input", (event) => {
        const video = $("member-video");
        const value = Number(event.target.value) / 100;
        video.volume = value;
        video.muted = value === 0;
        $("btn-mute").classList.toggle("text-rose-300", video.muted);
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
    setKind("host_file");
    setMemberSubtitleSize(storedMemberSubtitleSize());
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
