const mangayomiSources = [{
    "name": "티비위키",
    "lang": "ko",
    "baseUrl": "https://tvwiki51.net",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": true,
    "version": "0.1.2",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/tvwiki.js"
}];

// Aniyomi TVroom.kt(티비위키)를 망가요미용으로 옮긴 소스
const SIGNAL_URL = "https://aniyomi-extensions.pages.dev/api/signal";
const BRIDGE_URL = "https://dc-toki-mangayomi-media.pages.dev";
const DEFAULT_BASE_URL = "https://tvwiki51.net";
const DOMAIN_RE = /^https:\/\/tvwiki\d+\.net$/;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CACHE_TTL_MS = 10 * 60 * 1000;

const LIST_SELECTOR = "#list_type .box, #line_type .box, #mov_con_list .box, div.box, .slide_popular .box";
const NEXT_SELECTOR = "a[rel='next'], .pg_next, .pagination .next";
const TITLE_SELECTOR = "#bo_v_title .bo_v_tit, #bo_v_title h1, h1, .view-title";

const CATEGORIES = [
    ["전체", "all"], ["영화", "movie"], ["한국영화", "kor_movie"], ["드라마", "drama"],
    ["예능프로그램", "ent"], ["시사·다큐", "sisa"], ["해외드라마", "world"],
    ["해외 예능·다큐", "ott_ent"], ["숏폼 드라마", "short_drama"], ["극장판 애니", "ani_movie"],
    ["일반 애니", "animation"], ["추억의 예능", "old_ent"], ["추억의 드라마", "old_drama"],
];
const PERIODS = [["일간", "d"], ["주간", "w"], ["월간", "m"], ["전체 기간", "a"]];
const MODES = [["최신순", "latest"], ["인기순", "popular"]];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
        this.prefs = new SharedPreferences();
        this.cachedBase = null;
        this.cachedUntil = 0;
    }

    // ================= 주소 =================
    pref(key) {
        try {
            return this.prefs.get(key);
        } catch (e) {
            return null;
        }
    }

    cleanDomain(v) {
        const s = (v || "").trim().replace(/\/+$/, "");
        return DOMAIN_RE.test(s) ? s : null;
    }

    lastGood() {
        return this.cleanDomain(this.pref("tvwiki_last_good")) || DEFAULT_BASE_URL;
    }

    // 1순위 직접 지정 주소, 2순위 중앙신호등(10분 캐시), 실패하면 마지막 정상 주소
    async getBaseUrl() {
        const custom = this.cleanDomain(this.pref("tvwiki_domain"));
        if (custom) return custom;
        if (this.cachedBase && Date.now() < this.cachedUntil) return this.cachedBase;

        let base = this.lastGood();
        try {
            const res = await this.client.get(SIGNAL_URL, { "User-Agent": UA, "Accept": "application/json" });
            const fetched = this.cleanDomain(JSON.parse(res.body).tvwiki);
            // 마지막으로 성공한 주소보다 낮은 번호(예전 주소)는 쓰지 않음
            if (fetched && this.domainNumber(fetched) >= this.domainNumber(base)) base = fetched;
        } catch (e) {
            // 신호등 실패: 마지막 정상 주소 사용
        }
        this.cachedBase = base;
        this.cachedUntil = Date.now() + CACHE_TTL_MS;
        return base;
    }

    domainNumber(url) {
        const m = /tvwiki(\d+)\.net/.exec(url || "");
        return m ? parseInt(m[1], 10) : 0;
    }

    markGood(base) {
        if (base !== this.pref("tvwiki_last_good")) {
            try {
                this.prefs.setString("tvwiki_last_good", base);
            } catch (e) {
                // 저장 실패는 무시
            }
        }
    }

    headers(base, referer) {
        return { "User-Agent": UA, "Referer": referer || `${base}/` };
    }

    async getDoc(path) {
        const base = await this.getBaseUrl();
        const url = path.startsWith("http") ? path : base + path;
        const res = await this.client.get(url, this.headers(base));
        if (res.statusCode === 200) this.markGood(base);
        return { doc: new Document(res.body), base: base, url: url };
    }

    // ================= 목록 =================
    async popularBase(page) {
        return this.parseList(await this.getDoc(`/popular?page=${page}`));
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.parseList(await this.getDoc(`/drama?page=${page}`));
    }

    async searchBase(query, page, filters) {
        if (query && query.trim()) {
            const q = encodeURIComponent(query.trim());
            return this.parseList(await this.getDoc(`/search?stx=${q}&sst=subIdx&page=${page}`));
        }
        const pick = (i, list) => {
            const f = filters && filters[i];
            return list[(f && f.state) || 0][1];
        };
        const category = pick(0, CATEGORIES);
        const period = pick(1, PERIODS);
        const mode = pick(2, MODES);
        let path;
        if (mode === "popular") {
            const cat = category !== "all" ? `&sb=${category}` : "";
            path = `/popular?period=${period}${cat}&page=${page}`;
        } else {
            path = `/${category === "all" ? "drama" : category}?page=${page}`;
        }
        return this.parseList(await this.getDoc(path));
    }

    parseList({ doc, base }) {
        let elements = doc.select(LIST_SELECTOR);
        if (elements.length === 0) {
            elements = doc.select("a[href]").filter((a) =>
                /^\/(movie|kor_movie|drama|ent|ani|foreign_drama|docu)\/\d+$/.test(a.attr("href")));
        }
        const seen = {};
        const list = [];
        for (const el of elements) {
            const link = el.attr("href") ? el : el.selectFirst("a.title2, a.title, a.img, a[href]");
            if (!link) continue;
            const href = this.toPath(link.attr("href"), base);
            if (!href || href.includes("notice") || seen[href]) continue;

            const titleNode = el.selectFirst("a.title2, a.title, .subject, .title");
            const img = el.selectFirst("img");
            const rawTitle = (titleNode && (titleNode.attr("title") || titleNode.text.trim())) ||
                (img && img.attr("alt").trim()) || link.text.trim();
            const name = this.cleanSeriesTitle(rawTitle);
            if (!name) continue;

            seen[href] = true;
            list.push({ name: name, imageUrl: this.imageSrc(img, base), link: href });
        }
        return { list: list, hasNextPage: doc.selectFirst(NEXT_SELECTOR) != null };
    }

    // ================= 상세 / 회차 =================
    async getDetail(url) {
        const { doc, base } = await this.getDoc(url);
        const name = this.pageTitleOf(doc, "티비위키");
        const poster = doc.selectFirst(".poster img, .thumb img, img.cover, #bo_v_img img");
        const descNode = doc.selectFirst(".thumb-desc, .desc, .summary, .content, #bo_v_con");
        const year = /개봉년도\s*:\s*(\d{4})/.exec(doc.selectFirst("body") ? doc.selectFirst("body").text : "");

        return {
            name: name,
            imageUrl: this.imageSrc(poster, base),
            description: descNode ? descNode.text.trim() : "",
            genre: year ? [`${year[1]}년`] : [],
            status: 5,
            link: url,
            episodes: this.parseEpisodes(doc, base, url, name),
        };
    }

    parseEpisodes(doc, base, pageUrl, pageTitle) {
        const currentPath = this.toPath(pageUrl, base).replace(/\/+$/, "");
        const episodes = [];

        for (const item of doc.select("#other_list li")) {
            const link = item.selectFirst("a.title.ep-link, a.title, a.ep-link, a[href]");
            const href = link ? this.toPath(link.attr("href"), base) : "";
            if (!href) continue;
            const text = item.text.trim();
            episodes.push({ url: href, name: this.formatEpisodeName(text, pageTitle), num: this.episodeNumber(text) });
        }

        if (episodes.length === 0) {
            for (const link of doc.select("a[href]")) {
                const href = this.toPath(link.attr("href"), base);
                const text = link.text.trim();
                const isEpisodeUrl = href.startsWith(currentPath) && /\/\d+$/.test(href) && href !== currentPath;
                if (href && (isEpisodeUrl || /\d+\s*[화회]/.test(text))) {
                    episodes.push({ url: href, name: this.formatEpisodeName(text, pageTitle), num: this.episodeNumber(text) });
                }
            }
        }

        const seen = {};
        const unique = episodes.filter((e) => (seen[e.url] ? false : (seen[e.url] = true)));
        if (unique.length === 0) return [{ name: pageTitle, url: currentPath }];

        if (unique.length === 1 && (/줄거리/.test(unique[0].name) || unique[0].name === "1화")) {
            unique[0].name = pageTitle;
        }
        return unique.map((e) => ({ name: e.name, url: e.url }));
    }

    // ================= 재생 =================
    async getVideoList(url) {
        const base = await this.getBaseUrl();
        const episodePath = this.toPath(url, base);
        const parts = episodePath.replace(/^\/+|\/+$/g, "").split("/");
        if (parts.length < 3) return this.fallbackVideos(base, episodePath);

        const [boTable, wrId, epIdx] = parts;
        const pageUrl = base + episodePath;
        let meta;
        try {
            const res = await this.client.get(
                `${base}/bbs/get_episode.php?bo_table=${boTable}&wr_id=${wrId}&ep_idx=${epIdx}`,
                { "User-Agent": UA, "Referer": pageUrl, "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" });
            meta = JSON.parse(res.body);
        } catch (e) {
            return this.fallbackVideos(base, episodePath);
        }
        if (!meta || !meta.success || !meta.episode) return this.fallbackVideos(base, episodePath);

        const episode = meta.episode;
        const payloads = [episode.session_data1, episode.session_data2].filter((p) => p != null);
        const session = await this.createSession(base, episodePath, payloads);
        if (!session) return this.fallbackVideos(base, episodePath);

        const rawPlayer = session.player_url;
        const sep = rawPlayer.includes("?") ? "&" : "?";
        const playerUrl = this.resolveUrl(pageUrl, rawPlayer) +
            `${sep}t=${encodeURIComponent(session.t || "")}&sig=${encodeURIComponent(session.sig || "")}`;
        const playlistUrl = this.resolveUrl(playerUrl, episode.hls_url || "");
        const origin = (/^(https?:\/\/[^/]+)/.exec(playerUrl) || [null, base])[1];
        const streamHeaders = { "User-Agent": UA, "Accept": "*/*", "Referer": playerUrl, "Origin": origin };

        let playlist;
        try {
            playlist = (await this.client.get(playlistUrl, streamHeaders)).body;
        } catch (e) {
            return this.fallbackVideos(base, episodePath);
        }

        const keyMatch = /#EXT-X-KEY:[^\r\n]*URI="([^"]+)"/i.exec(playlist);
        if (!keyMatch) {
            return [{ url: playlistUrl, originalUrl: playlistUrl, quality: "자동 (HLS)", headers: streamHeaders }];
        }

        let envelope;
        try {
            envelope = (await this.client.get(this.resolveUrl(playlistUrl, keyMatch[1]), streamHeaders)).body;
        } catch (e) {
            return this.fallbackVideos(base, episodePath);
        }
        const common = `u=${encodeURIComponent(this.base64Url(playlistUrl))}` +
            `&r=${encodeURIComponent(this.base64Url(playerUrl))}` +
            `&x=${encodeURIComponent(this.base64Url(envelope))}`;
        const fast = `${BRIDGE_URL}/api/tvwiki-playlist.m3u8?m=f&${common}`;
        const proxy = `${BRIDGE_URL}/api/tvwiki-playlist.m3u8?m=p&${common}`;
        return [
            { url: fast, originalUrl: fast, quality: "빠른 재생 (CDN 직접)", headers: streamHeaders },
            { url: proxy, originalUrl: proxy, quality: "호환 재생 (중계)", headers: streamHeaders },
        ];
    }

    // 1순위 원본 서버, 실패하면 중계 서버로 재생 세션 생성
    async createSession(base, episodePath, payloads) {
        const pageUrl = base + episodePath;
        for (const payload of payloads) {
            const body = typeof payload === "string" && payload.trim().startsWith("{") ? JSON.parse(payload) : payload;
            try {
                const res = await this.client.post(`${base}/api/create_session.php`,
                    { "User-Agent": UA, "Referer": pageUrl, "Origin": base, "Content-Type": "application/json; charset=utf-8" },
                    body);
                const json = JSON.parse(res.body);
                if (json.success && json.player_url) return json;
            } catch (e) {
                // 중계 서버로 재시도
            }
            try {
                const res = await this.client.post(`${BRIDGE_URL}/api/tvwiki-session`,
                    { "User-Agent": UA, "Referer": `${BRIDGE_URL}/`, "Content-Type": "application/json; charset=utf-8" },
                    { baseUrl: base, episodePath: episodePath, sessionData: body });
                const json = JSON.parse(res.body);
                if (json.success && json.player_url) return json;
            } catch (e) {
                // 다음 세션 데이터로
            }
        }
        return null;
    }

    async fallbackVideos(base, episodePath) {
        const res = await this.client.get(base + episodePath, this.headers(base));
        const doc = new Document(res.body);
        const videos = [];
        for (const v of doc.select("video source, video")) {
            const src = this.resolveUrl(base + episodePath, v.attr("src"));
            if (v.attr("src")) videos.push({ url: src, originalUrl: src, quality: "직접 재생" });
        }
        return videos;
    }

    // ================= 필터 / 설정 =================
    baseFilterList() {
        const select = (name, items) => ({
            type_name: "SelectFilter",
            name: name,
            state: 0,
            values: items.map(([label, value]) => ({ type_name: "SelectOption", name: label, value: value })),
        });
        return [
            select("카테고리", CATEGORIES),
            select("기간 (인기순일 때)", PERIODS),
            select("정렬 방식", MODES),
        ];
    }

    // ---------- 상태 표시 ----------
    statusBase() {
        try {
            const b = typeof this.getBaseUrl === "function" ? this.getBaseUrl() : this.base;
            // getBaseUrl 이 비동기(Promise)인 확장은 마지막 정상 주소를 씀
            if (b && typeof b.then === "function") return (this.lastGood && this.lastGood()) || this.source.baseUrl;
            return b;
        } catch (e) {
            return this.source.baseUrl;
        }
    }

    statusAuto() {
        try {
            return typeof this.autoOn === "function" ? this.autoOn() : null;
        } catch (e) {
            return null;
        }
    }

    getFilterList() {
        return statusFilters("tvwiki", this.statusBase(), this.statusAuto()).concat(this.baseFilterList());
    }

    async getPopular(page) {
        await statusRefresh(this.client);
        return this.popularBase(page);
    }

    async search(query, page, filters) {
        await statusRefresh(this.client);
        // 맨 위 상태 줄은 빼고 넘김 (필터 순서 기준 동작 유지)
        return this.searchBase(query, page, (filters || []).filter((f) => !(f && f._status)));
    }

    getSourcePreferences() {
        return [{
            key: "tvwiki_domain",
            editTextPreference: {
                title: "티비위키 주소 직접 지정 (선택)",
                summary: "비워 두면 중앙신호등의 최신 주소를 사용하고, 실패하면 마지막 정상 주소로 복구합니다. 예: https://tvwiki51.net",
                value: "",
                dialogTitle: "티비위키 주소",
                dialogMessage: "tvwiki숫자.net 형식의 HTTPS 주소만 사용됩니다.",
            },
        }];
    }

    // ================= 유틸 =================
    toPath(href, base) {
        if (!href) return "";
        const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(href.trim());
        if (m) return m[1] || "/";
        return href.startsWith("/") ? href.trim() : `/${href.trim()}`;
    }

    resolveUrl(base, target) {
        const t = (target || "").trim();
        if (/^https?:\/\//.test(t)) return t;
        if (t.startsWith("//")) return `https:${t}`;
        const origin = (/^(https?:\/\/[^/]+)/.exec(base) || [null, ""])[1];
        if (t.startsWith("/")) return origin + t;
        // 쿼리 안의 / 때문에 경로가 잘리지 않도록 경로 부분에서만 자른다
        const path = base.replace(/[?#].*$/, "");
        return path.substring(0, path.lastIndexOf("/") + 1) + t;
    }

    imageSrc(img, base) {
        if (!img) return "";
        const src = img.attr("data-original") || img.attr("data-src") || img.attr("src");
        return src ? this.resolveUrl(`${base}/`, src) : "";
    }

    pageTitleOf(doc, fallback) {
        const og = doc.selectFirst("meta[property='og:title']");
        const node = doc.selectFirst(TITLE_SELECTOR);
        const raw = (og && og.attr("content")) || (node && node.text) || "";
        return this.cleanSeriesTitle(raw) || fallback;
    }

    cleanSeriesTitle(raw) {
        return (raw || "")
            .replace(/\s+\d+(?:[-.]\d+)?화(?:\s+다시보기)?\s*$/, "")
            .replace(/\s+다시보기(?:\s*-\s*티비위키)?\s*$/, "")
            .trim();
    }

    episodeNumber(text) {
        const m = /(\d+(?:\.\d+)?)(?:-\d+)?\s*[화회]/.exec(text || "");
        return m ? parseFloat(m[1]) : 0;
    }

    formatEpisodeName(raw, fallback) {
        let t = (raw || "").trim().replace(/등록된\s*줄거리가\s*없습니다\.?/, "").trim();
        const ep = /(\d+(?:[-.]\d+)?)\s*[화회]/.exec(t);
        const date = /(\d{4}[.-]\d{2}[.-]\d{2})/.exec(t);
        const sub = t.replace(/^.*?(\d+(?:[-.]\d+)?\s*[화회])/, "")
            .replace(/(\d{4}[.-]\d{2}[.-]\d{2})/, "")
            .replace(/^\s*[-:–]\s*/, "")
            .trim();
        let out = ep ? `${ep[1]}화` : "";
        if (date) out += (out ? " - " : "") + date[1];
        if (sub) out += (out ? " " : "") + sub;
        return out.trim() || fallback;
    }

    // 글자 → UTF-8 → base64url (패딩 없음). btoa가 없는 환경을 위해 직접 구현
    base64Url(value) {
        const bytes = [];
        for (const ch of unescape(encodeURIComponent(value))) bytes.push(ch.charCodeAt(0));
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let out = "";
        for (let i = 0; i < bytes.length; i += 3) {
            const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
            out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63];
            if (i + 1 < bytes.length) out += abc[(n >> 6) & 63];
            if (i + 2 < bytes.length) out += abc[n & 63];
        }
        return out;
    }
}

// ---------- 앱 기본 User-Agent 사용 ----------
// 망가요미는 내장 웹뷰에서 Cloudflare 확인을 통과하면 쿠키와 그 웹뷰의 User-Agent 를 함께 저장하고,
// 요청에 User-Agent 가 없을 때만 그 값을 넣는다. 확장이 고정 User-Agent 를 보내면 통과 쿠키가 거부되므로
// 사이트(문서·API) 요청에서는 확장의 User-Agent 를 빼고 앱 값을 쓰게 한다. 영상·이미지 주소 요청은 그대로 둔다.
function appClient(raw) {
    const media = /\.(?:m3u8|mp4|ts|m4s|jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
    const strip = (url, headers) => {
        if (!headers || media.test(String(url || ""))) return headers || {};
        const out = {};
        for (const k in headers) if (k.toLowerCase() !== "user-agent") out[k] = headers[k];
        return out;
    };
    return {
        get: (url, headers) => raw.get(url, strip(url, headers)),
        post: (url, headers, body) => raw.post(url, strip(url, headers), body),
    };
}

// ---------- 필터 화면 맨 위 상태 표시 (주소 · 자동 찾기 · 감시 점검 결과) ----------
// 점검 결과는 저장소 감시 작업이 올리는 status.json 을 20분에 한 번 받아 두었다가 보여 준다.
const STATUS_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/monitor-state/status.json";

function statusKst(iso) {
    const t = Date.parse(iso || "");
    if (isNaN(t)) return "";
    const d = new Date(t + 9 * 3600000).toISOString();
    return d.substring(5, 7) + "/" + d.substring(8, 10) + " " + d.substring(11, 16);
}

async function statusRefresh(client) {
    let p;
    try {
        p = new SharedPreferences();
    } catch (e) {
        return;
    }
    const last = Number(p.getString("status_at", "0")) || 0;
    if (Date.now() - last < 20 * 60000) return;
    p.setString("status_at", String(Date.now()));
    try {
        const r = await client.get(STATUS_URL, {});
        const body = String(r.body || "");
        if (r.statusCode === 200 && body.trim().startsWith("{")) p.setString("status_json", body);
    } catch (e) {
        // 다음 기회에 다시 받음
    }
}

function statusFilters(key, base, autoOn) {
    const host = String(base || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const lines = [`📡 주소: ${host}` + (autoOn === null || autoOn === undefined ? "" : ` · 자동 찾기 ${autoOn ? "켜짐" : "꺼짐"}`)];
    let item = null;
    try {
        item = (JSON.parse(new SharedPreferences().getString("status_json", "") || "{}").items || {})[key] || null;
    } catch (e) {
        item = null;
    }
    if (!item || item.ok === undefined) lines.push("🩺 점검: 정보 없음 (목록을 한 번 연 뒤 필터를 다시 열면 표시)");
    else if (item.ok) lines.push(`🩺 점검: 정상 · ${statusKst(item.checkedAt)}`);
    else lines.push(`❌ 점검: 문제 · ${statusKst(item.checkedAt)} · ${String(item.msg || "").substring(0, 40)}`);
    lines.push("🛡 Cloudflare에 막히면: 웹뷰 버튼으로 한 번 열어 통과");
    return lines.map((name) => ({ type_name: "HeaderFilter", name, _status: true }));
}
