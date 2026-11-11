/**
 * Jellyfin source for the host view: point it at a server, browse, pick an item.
 *
 * There is no Jellyfin configuration anywhere but here: the host types a URL
 * and an API key, this browser remembers the pair, and the room server is told
 * only when the host connects (and keeps it in memory for the room's life).
 * The key never reaches a member, and the server proxies every byte they play.
 */

const STORAGE_KEY = "hall_jellyfin_session";
const PAGE_SIZE = 60;

/** The last server this browser connected to: {url, token, user_id, user_name}. */
export function storedJellyfinConfig() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
        saved = null;
    }
    // A record from before addresses moved to the browser has a token but no
    // url; it cannot be used, so it is dropped and the host is asked once.
    if (!saved || !saved.token || !saved.url) {
        if (saved) forgetJellyfinConfig();
        return null;
    }
    return saved;
}

export function saveJellyfinConfig(url, token, userName, userId) {
    if (!url || !token) return;
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                url,
                token,
                user_name: userName || "",
                user_id: userId || "",
            })
        );
    } catch {
        // private mode or full quota: the config simply is not remembered
    }
}

export function forgetJellyfinConfig() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

/** The host part of a URL, for one-line messages: "jellyfin.example.com". */
function urlHost(url) {
    try {
        return new URL(url).host || url;
    } catch {
        return url || "";
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
        // Which way in the config row is showing: "key" or "password".
        this.mode = "key";
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

    /** Hand the room a server address and an API key; both come from here. */
    async connect(url, token, userId) {
        const data = await this.api("/jellyfin/session", {
            method: "POST",
            body: { url, token, user_id: userId || undefined },
        });
        this.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        return data;
    }

    /**
     * The other way in: the room logs in for us and answers with the token it
     * got, which is what we then remember instead of the password.
     */
    async signIn(url, username, password) {
        const data = await this.api("/jellyfin/session", {
            method: "POST",
            body: { url, username, password },
        });
        this.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        return data;
    }

    // -- config row ----------------------------------------------------
    /** Which half of the config row is showing: an API key or a login. */
    setMode(mode) {
        this.mode = mode === "password" ? "password" : "key";
        const password = this.mode === "password";
        const keyInput = document.getElementById("host-jellyfin-token");
        const userInput = document.getElementById("host-jellyfin-username");
        const passwordInput = document.getElementById("host-jellyfin-password");
        if (keyInput) keyInput.classList.toggle("hidden", password);
        if (userInput) userInput.classList.toggle("hidden", !password);
        if (passwordInput) passwordInput.classList.toggle("hidden", !password);
        const keyButton = document.getElementById("btn-jellyfin-mode-key");
        const passwordButton = document.getElementById("btn-jellyfin-mode-password");
        const paint = (button, active) => {
            if (!button) return;
            button.setAttribute("aria-pressed", active ? "true" : "false");
            button.classList.toggle("font-bold", active);
            button.classList.toggle("text-sky-300", active);
            button.classList.toggle("text-slate-400", !active);
        };
        paint(keyButton, !password);
        paint(passwordButton, password);
        if (password && userInput && !userInput.value) userInput.focus();
    }

    /** Prefill the fields from the last config, if there is one. */
    fillConfigRow() {
        const saved = storedJellyfinConfig();
        const url = document.getElementById("host-jellyfin-url");
        const key = document.getElementById("host-jellyfin-token");
        if (url && saved && !url.value) url.value = saved.url || "";
        if (key && saved && !key.value) key.value = saved.token || "";
        return saved;
    }

    showConfig(show, message = "") {
        const row = document.getElementById("host-jellyfin-config");
        const hint = document.getElementById("host-jellyfin-hint");
        if (!row) return;
        row.classList.toggle("hidden", !show);
        row.classList.toggle("flex", show);
        if (show) {
            this.fillConfigRow();
            // A failed attempt leaves the row on whichever half the host was
            // using, so the fields they filled are still the ones on screen.
            this.setMode(this.mode);
        }
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
                    "两种连法：填 Jellyfin 控制台里建的 API 密钥，或直接用账号和密码登录（密码只用于这一次登录，不会保存）。网址和令牌只存在这台浏览器里，服务器不保存任何配置。";
            }
        }
        if (show) {
            const url = document.getElementById("host-jellyfin-url");
            if (url && !url.value) url.focus();
        }
    }

    /**
     * Open the config row with what we already have, so "换一个服务器" is one
     * edit away: the old address and key are both there to be corrected.
     */
    openConfig() {
        this.close();
        this.showConfig(true);
        const target =
            this.mode === "password"
                ? document.getElementById("host-jellyfin-username")
                : document.getElementById("host-jellyfin-token");
        if (target) {
            target.focus();
            target.select();
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
        const saved = storedJellyfinConfig();
        if (state.authenticated) {
            this.showConfig(false);
            if (saved) {
                // Re-reads the library list for the dropdown; a failure here
                // only costs the picker, not the session the room already has.
                try {
                    await this.connect(saved.url, saved.token, saved.user_id);
                } catch {
                    // ignore
                }
            }
            await this.open();
            return;
        }
        if (saved) {
            // The remembered server is used without asking again.  A failure
            // keeps the fields filled in, so the host only has to correct
            // whichever half is wrong instead of typing both.
            try {
                await this.connect(saved.url, saved.token, saved.user_id);
                this.showConfig(false);
                await this.open();
                return;
            } catch (error) {
                this.showConfig(true, error.message || "记住的 Jellyfin 配置连不上，请检查网址和密钥");
                return;
            }
        }
        this.showConfig(true);
    }

    async submitConnect() {
        const urlInput = document.getElementById("host-jellyfin-url");
        const keyInput = document.getElementById("host-jellyfin-token");
        const userInput = document.getElementById("host-jellyfin-username");
        const passwordInput = document.getElementById("host-jellyfin-password");
        const button = document.getElementById("btn-jellyfin-connect");
        if (!urlInput || !keyInput || !button || button.disabled) return;
        const url = (urlInput.value || "").trim();
        const byPassword = this.mode === "password";
        const token = (keyInput.value || "").trim();
        const username = ((userInput && userInput.value) || "").trim();
        const password = (passwordInput && passwordInput.value) || "";
        if (!url || (byPassword ? !username || !password : !token)) {
            this.showConfig(
                true,
                byPassword ? "请填写 Jellyfin 网址、用户名和密码" : "请填写 Jellyfin 网址和密钥"
            );
            return;
        }
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "连接中…";
        try {
            const data = byPassword
                ? await this.signIn(url, username, password)
                : await this.connect(url, token);
            const account = (data.jellyfin && data.jellyfin.user_name) || "";
            // The server hands back the address it settled on (a bare host
            // became https://…), so the field and the record agree.
            const settled = data.url || url;
            urlInput.value = settled;
            // Remember the token, never the password: a login throws the
            // password away and leaves us the token it traded for, so the next
            // visit skips both fields.
            const remembered = byPassword ? (data.token || "") : token;
            if (remembered) {
                saveJellyfinConfig(
                    settled,
                    remembered,
                    account,
                    data.jellyfin && data.jellyfin.user_id
                );
                keyInput.value = remembered;
            }
            if (passwordInput) passwordInput.value = "";
            this.setMode("key");
            this.showConfig(false);
            const host = urlHost(settled);
            this.toast(account ? `已连接 Jellyfin：${host}（${account}）` : `已连接 Jellyfin：${host}`, "success");
            await this.open();
        } catch (error) {
            this.showConfig(true, error.message || "连接 Jellyfin 失败");
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
        on("btn-jellyfin-connect", "click", () => this.submitConnect());
        on("btn-jellyfin-cancel", "click", () => this.showConfig(false));
        on("btn-jellyfin-mode-key", "click", () => this.setMode("key"));
        on("btn-jellyfin-mode-password", "click", () => this.setMode("password"));
        for (const id of [
            "host-jellyfin-url",
            "host-jellyfin-token",
            "host-jellyfin-username",
            "host-jellyfin-password",
        ]) {
            on(id, "keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    this.submitConnect();
                }
            });
        }
        on("btn-jellyfin-config", "click", () => this.openConfig());
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

    /** Drop everything tied to the previous room; the config survives. */
    reset() {
        this.libraries = [];
        this.libraryId = "";
        this.trail = [];
        this.items = [];
        this.total = 0;
        this.showConfig(false);
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
            // Which server this room is browsing, and as whom: the host picks
            // both, so the header is where they can be checked at a glance.
            const saved = storedJellyfinConfig();
            const host = saved ? urlHost(saved.url) : "";
            const name = (saved && saved.user_name) || "";
            who.textContent = [host, name && `（${name}）`].filter(Boolean).join("") || "--";
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
                // The room lost its connection: the remembered config is still
                // in the fields, so all that is left is to connect again.
                this.close();
                this.showConfig(true, "Jellyfin 连接已失效，请重新填写网址和密钥");
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
