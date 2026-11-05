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

const state = {
    kind: "host_file",
    role: null,
    room: null,
    host: null,
    member: null,
};

const overlayEntries = new Map();
const OVERLAY_PRIORITY = ["ended", "fatal", "offline", "blocked", "connecting", "media", "buffering"];
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

async function createRoom() {
    showError("create-error", "");
    const name = ($("create-name").value || "").trim() || "媒体播放厅";
    let media;
    let file = null;

    if (state.kind === "host_file") {
        file = $("create-file").files[0];
        if (!file) {
            showError("create-error", "请先选择一个视频文件");
            return;
        }
        if (!isLikelyVideo(file)) {
            showError("create-error", "请选择浏览器可播放的视频文件（mp4 / webm / mov 等）");
            return;
        }
        if (file.size <= 0) {
            showError("create-error", "文件为空，无法创建房间");
            return;
        }
        if (file.size > MAX_HOST_FILE_BYTES) {
            showError("create-error", "文件超过 64GB，暂不支持");
            return;
        }
        media = {
            kind: "host_file",
            name: file.name,
            size: file.size,
            mime: file.type || "application/octet-stream",
        };
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
        const data = await request("/hall/api/rooms", { method: "POST", body: { name, media } });
        const session = {
            room_id: data.room_id,
            room_code: data.room_code,
            host_token: data.host_token,
            media_url: data.media_url,
            name,
            media: data.media,
        };
        state.room = session;
        try {
            sessionStorage.setItem(HOST_KEY, JSON.stringify(session));
        } catch {
            // ignore storage failures
        }
        window.history.replaceState({}, "", `?room=${encodeURIComponent(data.room_code)}`);
        startHost(session, file, data.room);
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

function startHost(session, file, room) {
    if (state.host) {
        state.host.stop();
        state.host = null;
    }
    state.role = "host";

    $("host-room-name").textContent = room && room.name ? room.name : session.name;
    $("host-media-name").textContent = session.media
        ? `${session.media.name} · ${fmtBytes(session.media.size)}`
        : "在线视频";
    $("host-room-code").textContent = session.room_code;
    $("host-position").textContent = "00:00";
    $("host-rate").textContent = "1.00x";
    $("host-buffered").textContent = "--";
    updateHostMembers(room ? room.members : []);
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
        onError: (message) => toast(message, "error"),
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
    toast("房间已结束", "success");
}

// -- member ----------------------------------------------------------
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
    overlay.classList.toggle("bg-slate-950/30", buffering);
    overlay.classList.toggle("bg-slate-950/85", !buffering);
    overlay.classList.toggle("backdrop-blur-sm", !buffering);
    textEl.textContent = entry.text;
    if (entry.actionLabel && typeof entry.action === "function") {
        button.textContent = entry.actionLabel;
        button.classList.remove("hidden");
        overlayAction = entry.action;
    } else {
        button.classList.add("hidden");
        overlayAction = null;
    }
}

function updateMemberMembers(members) {
    renderMembers($("member-members"), members, {
        hostName: "房主",
        selfId: state.member && state.member.session ? state.member.session.member_id : null,
        emptyText: "房间里只有你",
    });
}

function startMember(session, room) {
    if (state.member) {
        state.member.destroy();
        state.member = null;
    }
    state.role = "member";
    state.member = { session, controller: null };
    overlayEntries.clear();

    $("member-room-name").textContent = (room && room.name) || session.room_name || "媒体播放厅";
    $("member-room-code").textContent = session.room_code;
    $("member-rtt").textContent = "--";
    $("member-drift").textContent = "--";
    $("member-d").textContent = "0.5s";
    $("member-rate").textContent = "1.00x";
    setStatusBadge("member-host-badge", "连接中", "muted");
    $("member-status").textContent = "正在连接房间…";
    if (room) {
        updateMemberMembers(room.members || []);
        if (room.host && room.host.online !== false) {
            setStatusBadge("member-host-badge", "房主在线", "good");
        }
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
            setStatusBadge("member-host-badge", hostOnline ? "房主在线" : "房主离线", hostOnline ? "good" : "bad");
        },
        onHostState: (host) => {
            const online = host.online !== false;
            setStatusBadge("member-host-badge", online ? "房主在线" : "房主离线", online ? "good" : "bad");
            if (!online) {
                $("member-status").textContent = "房主已离线，等待重新连接…";
            } else if (host.playing) {
                $("member-status").textContent = host.buffering ? "房主正在缓冲…" : "跟随房主播放中";
            } else {
                $("member-status").textContent = "房主已暂停";
            }
        },
        onMembers: (members) => updateMemberMembers(members),
        onConnected: () => {
            $("member-status").textContent = "已连接，正在同步…";
        },
        onDisconnected: (message, fatal) => {
            if (fatal) {
                setStatusBadge("member-host-badge", "连接断开", "bad");
                $("member-status").textContent = message || "连接已断开";
            } else {
                setStatusBadge("member-host-badge", "重连中", "warn");
                $("member-status").textContent = message || "连接中断，正在重连…";
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
            $("member-status").textContent = "房间已结束";
        },
        onTokenInvalid: () => {
            try {
                sessionStorage.removeItem(memberKey(session.room_code));
            } catch {
                // ignore
            }
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
        if (document.visibilityState === "visible" && state.role === "host") {
            requestWakeLock();
        }
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
    if (!stored || !stored.member_token || !stored.media_url) return false;

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
}

init();
