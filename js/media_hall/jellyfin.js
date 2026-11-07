/**
 * Jellyfin source for the host view: sign in, browse the library, pick an item.
 *
 * The access token belongs to the host alone.  It is stored in this browser
 * for a week and handed to the room server, which keeps it in memory; members
 * never see it, and the server proxies every byte they play.
 */

const STORAGE_KEY = "hall_jellyfin_session";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 60;

export function storedJellyfinToken() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
        saved = null;
    }
    if (!saved || !saved.token) return null;
    if (saved.exp && Number(saved.exp) < Date.now()) {
        forgetJellyfinToken();
        return null;
    }
    return saved;
}

export function saveJellyfinToken(token, userName, userId) {
    if (!token) return;
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                token,
                user_name: userName || "",
                user_id: userId || "",
                exp: Date.now() + TOKEN_TTL_MS,
            })
        );
    } catch {
        // private mode or full quota: the token simply is not remembered
    }
}

export function forgetJellyfinToken() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

function fmtDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) return "";
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

function fmtBitrate(bits) {
    const value = Number(bits) || 0;
    if (!value) return "";
    return `${Math.round(value / 100000) / 10} Mbps`;
}

export class JellyfinPicker {
    constructor({ request, getRoom, toast, onPick }) {
        this.request = request;
        this.getRoom = getRoom;
        this.toast = toast;
        this.onPick = onPick || (() => {});
        this.libraries = [];
        this.libraryId = "";
        // Where the host currently is: libraries → folders/series → episodes.
        this.trail = [];
        this.items = [];
        this.total = 0;
        this.seq = 0;
        this.loadingMore = false;
        this.wired = false;
    }

    // -- server calls --------------------------------------------------
    api(path, options = {}) {
        const room = this.getRoom();
        if (!room) return Promise.reject(new Error("房间还没有准备好"));
        return this.request(`/hall/api/rooms/${encodeURIComponent(room.room_id)}${path}`, {
            ...options,
            headers: { "X-Host-Token": room.host_token, ...(options.headers || {}) },
        });
    }

    status() {
        return this.api("/jellyfin/status");
    }

    async signIn(username, password) {
        const data = await this.api("/jellyfin/session", {
            method: "POST",
            body: { username, password },
        });
        this.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        return data;
    }

    async adopt(token, userId) {
        const data = await this.api("/jellyfin/session", {
            method: "POST",
            body: { token, user_id: userId || undefined },
        });
        this.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        return data;
    }

    // -- login row -----------------------------------------------------
    showLogin(show, message = "") {
        const row = document.getElementById("host-jellyfin-login");
        const hint = document.getElementById("host-jellyfin-hint");
        if (!row) return;
        row.classList.toggle("hidden", !show);
        row.classList.toggle("flex", show);
        if (hint) {
            hint.classList.toggle("hidden", !show);
            hint.classList.remove("text-rose-300");
            hint.classList.add("text-slate-500");
            if (message) {
                hint.textContent = message;
                hint.classList.remove("text-slate-500");
                hint.classList.add("text-rose-300");
            } else {
                hint.textContent =
                    "用你的 Jellyfin 账号登录。密码只用于这一次换取令牌，浏览器只记住 7 天有效的访问令牌。";
            }
        }
        if (show) {
            const user = document.getElementById("host-jellyfin-user");
            if (user && !user.value) user.focus();
        }
    }

    /** Called when the host picks "Jellyfin" from the add-media menu. */
    async begin() {
        const room = this.getRoom();
        if (!room) return;
        this.wire();
        let state;
        try {
            state = await this.status();
        } catch (error) {
            this.toast(error.message || "无法连接媒体厅服务", "error");
            return;
        }
        if (!state.enabled) {
            this.toast("这台服务器的媒体厅没有启用 Jellyfin 源", "error");
            return;
        }
        if (state.authenticated) {
            this.showLogin(false);
            const known = storedJellyfinToken();
            if (known) {
                // Re-reads the library list for the dropdown; a failure here
                // only costs the picker, not the session the room already has.
                try {
                    await this.adopt(known.token, known.user_id);
                } catch {
                    // ignore
                }
            }
            await this.open();
            return;
        }
        const saved = storedJellyfinToken();
        if (saved) {
            try {
                await this.adopt(saved.token, saved.user_id);
                await this.open();
                return;
            } catch (error) {
                // The token expired or was revoked on the Jellyfin side.
                forgetJellyfinToken();
                this.showLogin(true, error.message || "记住的登录已失效，请重新登录");
                return;
            }
        }
        this.showLogin(true);
    }

    async submitLogin() {
        const userInput = document.getElementById("host-jellyfin-user");
        const passInput = document.getElementById("host-jellyfin-pass");
        const button = document.getElementById("btn-jellyfin-login");
        if (!userInput || !passInput || !button || button.disabled) return;
        const username = (userInput.value || "").trim();
        const password = passInput.value || "";
        if (!username || !password) {
            this.showLogin(true, "请填写用户名和密码");
            return;
        }
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "登录中…";
        try {
            const data = await this.signIn(username, password);
            // Only the token is remembered; the password is dropped right here.
            passInput.value = "";
            if (data.token) {
                saveJellyfinToken(
                    data.token,
                    data.jellyfin && data.jellyfin.user_name,
                    data.jellyfin && data.jellyfin.user_id
                );
            }
            this.showLogin(false);
            const name = (data.jellyfin && data.jellyfin.user_name) || username;
            this.toast(`已登录 Jellyfin：${name}`, "success");
            await this.open();
        } catch (error) {
            this.showLogin(true, error.message || "登录失败");
        } finally {
            button.disabled = false;
            button.textContent = label;
        }
    }

    // -- browser overlay -----------------------------------------------
    wire() {
        if (this.wired) return;
        this.wired = true;
        const on = (id, event, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener(event, handler);
        };
        on("btn-jellyfin-login", "click", () => this.submitLogin());
        on("btn-jellyfin-cancel", "click", () => this.showLogin(false));
        on("host-jellyfin-pass", "keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.submitLogin();
            }
        });
        on("jellyfin-close", "click", () => this.close());
        on("jellyfin-more", "click", () => this.loadMore());
        on("jellyfin-library", "change", (event) => this.jumpToLibrary(event.target.value || ""));
        on("jellyfin-search-btn", "click", () => this.search());
        on("jellyfin-search", "keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.search();
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            const overlay = document.getElementById("jellyfin-browser");
            if (!overlay || overlay.classList.contains("hidden")) return;
            this.close();
        });
    }

    search() {
        const input = document.getElementById("jellyfin-search");
        const text = input ? (input.value || "").trim() : "";
        if (!this.trail.length) return;
        const top = this.trail[this.trail.length - 1];
        if (!text) {
            if (top.search) this.trail.pop();
            this.renderCrumbs();
            this.loadItems(true);
            return;
        }
        // A search always runs over the whole library, so the trail collapses
        // back to its root: keeping the folder crumbs would claim the results
        // came from inside that folder.
        const frame = { id: this.libraryId, name: `搜索「${text}」`, mode: "children", query: text, search: true };
        this.trail = [this.trail[0], frame];
        this.renderCrumbs();
        this.loadItems(true);
    }

    /** Drop everything tied to the previous room; the token survives. */
    reset() {
        this.libraries = [];
        this.libraryId = "";
        this.trail = [];
        this.items = [];
        this.total = 0;
        this.showLogin(false);
        this.close();
        const search = document.getElementById("jellyfin-search");
        if (search) search.value = "";
    }

    rootFrame() {
        const library = this.libraries.find((item) => item.id === this.libraryId);
        return {
            id: this.libraryId,
            name: (library && library.name) || "媒体库",
            mode: "children",
            query: "",
        };
    }

    current() {
        return this.trail[this.trail.length - 1] || null;
    }

    async open() {
        const overlay = document.getElementById("jellyfin-browser");
        if (!overlay) return;
        overlay.classList.remove("hidden");
        document.body.classList.add("overflow-hidden");
        if (!this.libraryId && this.libraries.length) this.libraryId = this.libraries[0].id;
        this.renderLibraries();
        this.trail = [this.rootFrame()];
        this.renderCrumbs();
        await this.loadItems(true);
    }

    close() {
        const overlay = document.getElementById("jellyfin-browser");
        if (overlay) overlay.classList.add("hidden");
        document.body.classList.remove("overflow-hidden");
    }

    jumpToLibrary(id) {
        this.libraryId = id;
        const search = document.getElementById("jellyfin-search");
        if (search) search.value = "";
        this.trail = [this.rootFrame()];
        this.renderCrumbs();
        this.loadItems(true);
    }

    /** Walk into a folder, or into a series' episode list. */
    enter(item) {
        if (!item || !item.is_folder) return;
        const mode = item.kind === "series" || item.kind === "season" ? "episodes" : "children";
        this.trail.push({ id: item.id, name: item.name || "未命名", mode, query: "" });
        this.renderCrumbs();
        this.loadItems(true);
    }

    goToCrumb(index) {
        if (index < 0 || index >= this.trail.length - 1) return;
        this.trail = this.trail.slice(0, index + 1);
        const search = document.getElementById("jellyfin-search");
        if (search) search.value = this.current().query || "";
        this.renderCrumbs();
        this.loadItems(true);
    }

    setStatus(text, tone = "muted") {
        const node = document.getElementById("jellyfin-status");
        if (!node) return;
        node.classList.toggle("hidden", !text);
        node.textContent = text || "";
        node.className = "mb-3 text-xs";
        node.classList.toggle("text-rose-300", tone === "error");
        node.classList.toggle("text-slate-400", tone !== "error");
    }

    renderLibraries() {
        const select = document.getElementById("jellyfin-library");
        const who = document.getElementById("jellyfin-who");
        if (who) {
            const saved = storedJellyfinToken();
            who.textContent = saved && saved.user_name ? `已登录 ${saved.user_name}` : "已登录";
        }
        if (!select) return;
        select.replaceChildren();
        if (!this.libraries.length) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "媒体库";
            select.appendChild(option);
        }
        for (const library of this.libraries) {
            const option = document.createElement("option");
            option.value = library.id;
            option.textContent = library.name || "媒体库";
            select.appendChild(option);
        }
        select.value = this.libraryId;
    }

    renderCrumbs() {
        const bar = document.getElementById("jellyfin-crumbs");
        if (!bar) return;
        bar.replaceChildren();
        this.trail.forEach((frame, index) => {
            if (index) {
                const sep = document.createElement("span");
                sep.className = "px-1 text-slate-600";
                sep.textContent = "/";
                bar.appendChild(sep);
            }
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = frame.name || "媒体库";
            const last = index === this.trail.length - 1;
            button.className = last
                ? "max-w-[18rem] truncate rounded-lg px-2 py-1 font-semibold text-slate-200"
                : "max-w-[18rem] truncate rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-800/70 hover:text-sky-300";
            if (!last) button.addEventListener("click", () => this.goToCrumb(index));
            bar.appendChild(button);
        });

        const up = document.createElement("button");
        up.type = "button";
        up.textContent = "返回上级";
        up.className = "ml-1 rounded-lg border border-slate-700/60 px-2 py-1 text-slate-300 transition hover:border-sky-500/50 hover:text-sky-300";
        up.disabled = this.trail.length < 2;
        if (this.trail.length >= 2) {
            up.addEventListener("click", () => this.goToCrumb(this.trail.length - 2));
        } else {
            up.className = "ml-1 invisible rounded-lg px-2 py-1";
        }
        bar.appendChild(up);
    }

    async loadMore() {
        if (this.loadingMore || this.items.length >= this.total) return;
        await this.loadItems(false);
    }

    async loadItems(reset = false) {
        const frame = this.current();
        if (!frame) return;
        const start = reset ? 0 : this.items.length;
        const seq = ++this.seq;
        this.loadingMore = !reset;
        if (reset) {
            this.items = [];
            this.total = 0;
            this.renderItems([]);
            const list = document.getElementById("jellyfin-items");
            if (list) list.scrollTop = 0;
        }
        this.setStatus("正在读取片库…");
        const params = new URLSearchParams({
            start: String(start),
            limit: String(PAGE_SIZE),
            mode: frame.mode,
        });
        if (frame.id) params.set("parent", frame.id);
        if (frame.query) params.set("q", frame.query);
        try {
            const data = await this.api(`/jellyfin/items?${params.toString()}`);
            // A fast double click can land two answers out of order; only the
            // newest request may touch the list.
            if (seq !== this.seq) return;
            const incoming = Array.isArray(data.items) ? data.items : [];
            this.items = reset ? incoming : this.items.concat(incoming);
            this.total = Number(data.total) || this.items.length;
            this.renderItems(this.items);
            this.updateStatus(frame);
        } catch (error) {
            if (seq !== this.seq) return;
            this.setStatus(error.message || "读取片库失败", "error");
            if (error.code === "JELLYFIN_AUTH_REQUIRED" || error.code === "JELLYFIN_AUTH_FAILED") {
                forgetJellyfinToken();
                this.showLogin(true, "登录已失效，请重新登录");
            }
        } finally {
            if (seq === this.seq) this.loadingMore = false;
        }
    }

    updateStatus(frame) {
        const more = document.getElementById("jellyfin-more");
        if (more) more.classList.toggle("hidden", this.items.length >= this.total);
        if (!this.items.length) {
            const empty = frame.mode === "episodes"
                ? "这部剧还没有分集"
                : frame.search
                    ? "没有找到匹配的影片"
                    : "这一层没有可播放的内容";
            this.setStatus(empty);
            return;
        }
        this.setStatus(`共 ${this.total} 项，已显示 ${this.items.length} 项`);
    }

    renderItems(items) {
        const list = document.getElementById("jellyfin-items");
        if (!list) return;
        list.replaceChildren();
        if (!items.length) {
            const empty = document.createElement("li");
            empty.className = "text-xs italic text-slate-600";
            empty.textContent = "正在读取…";
            list.appendChild(empty);
            return;
        }
        for (const item of items) {
            list.appendChild(item.is_folder ? this.folderRow(item) : this.playableRow(item));
        }
    }

    folderRow(item) {
        const row = document.createElement("li");
        const open = document.createElement("button");
        open.type = "button";
        open.className =
            "flex w-full items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-2 text-left transition hover:border-sky-500/50 hover:bg-slate-900/70";
        const left = document.createElement("div");
        left.className = "min-w-0";
        const title = document.createElement("div");
        title.className = "truncate text-xs font-semibold text-slate-200";
        title.textContent = item.name || "未命名";
        const meta = document.createElement("div");
        meta.className = "mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500";
        const bits = [folderLabel(item.kind)];
        if (item.child_count) bits.push(`共 ${item.child_count} 项`);
        if (item.series_name) bits.push(item.series_name);
        for (const text of bits.filter(Boolean)) {
            const span = document.createElement("span");
            span.textContent = text;
            meta.appendChild(span);
        }
        left.append(title, meta);
        const chevron = document.createElement("span");
        chevron.className = "shrink-0 text-sm text-slate-500";
        chevron.textContent = "›";
        open.append(left, chevron);
        open.addEventListener("click", () => this.enter(item));
        row.appendChild(open);
        return row;
    }

    playableRow(item) {
        const row = document.createElement("li");
        row.className =
            "flex items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-2";

        const left = document.createElement("div");
        left.className = "min-w-0";
        const title = document.createElement("div");
        title.className = "truncate text-xs font-semibold text-slate-200";
        title.textContent = item.name || "未命名";
        const meta = document.createElement("div");
        meta.className = "mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500";
        // Episodes whose own title already starts with "S02E01" do not need
        // the same badge repeated next to it.
        const badge = episodeLabel(item);
        const rowTitle = item.name || "";
        const bits = [
            badge && !rowTitle.includes(badge) ? badge : "",
            item.series_name && !rowTitle.includes(item.series_name) ? item.series_name : "",
            fmtDuration(item.duration),
            fmtBitrate(item.bitrate),
            (item.container || "").toUpperCase(),
        ].filter(Boolean);
        for (const text of bits) {
            const span = document.createElement("span");
            span.textContent = text;
            meta.appendChild(span);
        }
        if (item.mode === "hls") {
            const tag = document.createElement("span");
            tag.className = "rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300";
            tag.textContent = "转码";
            meta.appendChild(tag);
        }
        left.append(title, meta);

        const add = document.createElement("button");
        add.type = "button";
        add.className =
            "shrink-0 rounded-lg border border-slate-700/60 bg-slate-900/60 px-2 py-1 text-[10px] font-bold text-slate-300 transition hover:border-sky-500/50 hover:text-sky-300";
        add.textContent = "加入";
        add.addEventListener("click", () => {
            add.disabled = true;
            add.textContent = "…";
            Promise.resolve(this.onPick(item))
                .catch(() => {
                    // the caller reports its own errors
                })
                .finally(() => {
                    add.disabled = false;
                    add.textContent = "加入";
                });
        });

        row.append(left, add);
        return row;
    }
}

const KIND_LABELS = {
    series: "剧集",
    season: "季",
    folder: "文件夹",
    movie: "影片",
    episode: "分集",
    video: "视频",
    item: "条目",
};

function folderLabel(kind) {
    return KIND_LABELS[kind] || "目录";
}

function episodeLabel(item) {
    if (item.kind !== "episode" && item.season == null && item.episode == null) return "";
    const season = Number(item.season);
    const episode = Number(item.episode);
    if (season === 0 && episode) return `特别篇 ${episode}`;
    if (season && episode) return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    if (episode) return `第 ${episode} 集`;
    return "";
}
