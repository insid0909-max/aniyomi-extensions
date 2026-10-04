const mangayomiSources = [{
    "name": "티비착",
    "lang": "ko",
    "baseUrl": "https://tvchak208.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": true,
    "version": "0.1.6",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/tvchak.js"
}];

// Aniyomi TVchak.kt(티비착)를 망가요미용으로 옮긴 소스 - MacCMS 사이트, 재생 페이지의 player_aaaa 에 영상 주소가 들어 있음
const DEFAULT_BASE_URL = "https://tvchak208.com";
const DOMAIN_RE = /^https:\/\/tvchak\d+\.com$/;
const HOST_NUM = /tvchak(\d+)\.com/;
const SITE_MARKER = "티비착";
const PLAYER_REFERER = "https://ckp2.wiselife.blog/";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const MEDIA_RE = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/i;

const TYPES = [
    ["전체", ""], ["영화", "1"], ["드라마", "2"], ["드라마 - 월화", "13"], ["드라마 - 수목", "14"],
    ["드라마 - 금요/주말", "15"], ["드라마 - 일일", "21"], ["드라마 - 다시보기", "22"], ["숏드", "39"],
    ["예능", "3"], ["예능 - 월요일", "23"], ["예능 - 화요일", "24"], ["예능 - 수요일", "25"], ["예능 - 목요일", "26"],
    ["예능 - 금요일", "27"], ["예능 - 토요일", "28"], ["예능 - 일요일", "29"], ["애니", "4"],
];
const SORTS = [["최신순", "time"], ["인기순", "hits"]];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    // ================= 주소 =================
    getBaseUrl() {
        let custom = "";
        let auto = "";
        try {
            const p = new SharedPreferences();
            custom = (p.get("tvchak_domain") || "").trim().replace(/\/+$/, "");
            auto = (p.getString("tvchak_auto_domain", "") || "").trim();
        } catch (e) {
            custom = "";
        }
        if (DOMAIN_RE.test(custom)) return custom;
        return DOMAIN_RE.test(auto) ? auto : DEFAULT_BASE_URL;
    }

    autoOn() {
        try {
            const v = new SharedPreferences().get("tvchak_auto_on");
            return v !== false && v !== "false";
        } catch (e) {
            return true;
        }
    }

    headers(referer) {
        return { "User-Agent": UA, "Referer": referer || `${this.getBaseUrl()}/` };
    }

    /** 접속이 안 되면(오류/5xx) tvchak 번호 주소를 찾아 바꾼 뒤 다시 요청 */
    async getHtml(path) {
        const base = this.getBaseUrl();
        const url = path.startsWith("http") ? path : base + path;
        let res = null;
        try {
            res = await this.client.get(url, this.headers());
            if (res.statusCode < 500 && String(res.body || "").length > 0) return { html: res.body, base, res };
        } catch (e) {
            res = null;
        }
        const found = this.autoOn() ? await this.discover(base) : null;
        if (!found) {
            if (res) return { html: res.body, base, res };
            throw new Error(`접속 실패: ${url}`);
        }
        const r2 = await this.client.get(found + url.substring(base.length), this.headers(`${found}/`));
        return { html: r2.body, base: found, res: r2 };
    }

    async getDoc(path) {
        const { html, base } = await this.getPage(path);
        return { doc: new Document(html), base };
    }

    /** 사이트(CloudFront)가 일정 시간마다 실제 페이지 대신 보안 확인 페이지를 보냄 → 빈 목록 대신 안내 */
    async getPage(path) {
        const r = await this.getHtml(path);
        if (String(r.html || "").includes("maccms")) return r;
        // 앱이 숨은 WebView 실행을 지원하면, 그 안에서 보안 확인을 끝내고 실제 페이지 내용을 받아 씀
        const url = path.startsWith("http") ? path : r.base + path;
        let html = null;
        // 숨은 WebView 는 앱이 15초만 기다려 주므로 최대 두 번 시도.
        // 결과를 못 받아도 그 사이 통과 쿠키가 저장됐을 수 있으니 매번 원래 요청을 다시 해 본다
        for (let i = 0; i < 2; i++) {
            html = await this.viaWebview(url);
            if (html && html.includes("maccms")) return { html, base: r.base };
            const again = await this.getHtml(path);
            if (String(again.html || "").includes("maccms")) return again;
        }
        throw new Error("사이트 보안 확인이 필요합니다. 오른쪽 위 지구본(WebView) 버튼으로 한 번 열었다 닫은 뒤 다시 불러오세요." +
            ` [진단: ${this.diag(r, html)}]`);
    }

    /** 보안 확인 페이지가 어떤 것인지 알 수 있게 짧게 요약 (캡처해서 보내 주시면 원인 파악용) */
    diag(r, webHtml) {
        const body = String(r.html || "");
        const res = r.res || {};
        const h = res.headers || {};
        const pick = (k) => {
            for (const key in h) if (key.toLowerCase() === k) return String(h[key]).substring(0, 60);
            return "";
        };
        const title = (/<title>([^<]*)/i.exec(body) || [null, ""])[1].trim().substring(0, 40);
        const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ").trim().substring(0, 80);
        const hints = ["awswaf", "challenge", "captcha", "cf-", "turnstile", "location.reload", "document.cookie"]
            .filter((w) => body.toLowerCase().includes(w));
        return [
            `상태 ${res.statusCode}`,
            `크기 ${body.length}`,
            `제목 "${title}"`,
            `server ${pick("server")}`,
            pick("x-amzn-waf-action") ? `waf ${pick("x-amzn-waf-action")}` : "",
            `웹뷰 ${typeof evaluateJavascriptViaWebview === "function" ? (webHtml ? "응답" + String(webHtml).length : "응답없음") : "미지원"}`,
            hints.length ? `단서 ${hints.join(",")}` : "",
            `내용 "${text}"`,
        ].filter((x) => x).join(" · ");
    }

    async viaWebview(url) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        // 페이지에 실제 내용(maccms)이 나타날 때까지 기다렸다가 HTML 을 앱으로 돌려줌
        // 확인 페이지에서는 기다리고(확인이 끝나면 사이트가 스스로 새로고침), 실제 페이지가 열리면 바로 HTML 을 돌려줌
        const script = "(function(){function f(){var h=document.documentElement.outerHTML;" +
            "if(h.indexOf('maccms')>=0){window.flutter_inappwebview.callHandler('setResponse',h);return true;}return false;}" +
            "if(!f()){var t=setInterval(function(){if(f())clearInterval(t);},300);}})();";
        try {
            const timeout = new Promise((res) => setTimeout(() => res(null), 30000));
            const res = await Promise.race([
                evaluateJavascriptViaWebview(url, {}, [script]),
                timeout,
            ]);
            return res ? String(res) : null;
        } catch (e) {
            return null;
        }
    }

    async discover(current) {
        const p = new SharedPreferences();
        const last = Number(p.getString("tvchak_auto_at", "0")) || 0;
        if (Date.now() - last < 60000) return null;
        p.setString("tvchak_auto_at", String(Date.now()));
        const num = (u) => parseInt((u.match(HOST_NUM) || [0, "0"])[1], 10) || 0;
        const cur = num(current) || num(DEFAULT_BASE_URL);
        const cands = [];
        for (let i = Math.max(1, cur - 5); i <= cur + 30; i++) {
            const c = `https://tvchak${i}.com`;
            if (c !== current) cands.push(c);
        }
        const hits = await Promise.all(cands.map(async (c) => {
            try {
                const r = await this.client.get(c + "/", { "User-Agent": UA });
                return r.statusCode === 200 && String(r.body || "").includes(SITE_MARKER) ? c : null;
            } catch (e) {
                return null;
            }
        }));
        const ok = hits.filter((x) => x).sort((a, b) => num(b) - num(a));
        if (ok[0]) p.setString("tvchak_auto_domain", ok[0]);
        return ok[0] || null;
    }

    // ================= 목록 =================
    showPath(type, sort, page) {
        return "/index.php/vod/show" + (type ? `/id/${type}` : "") + `/by/${sort}` + (page > 1 ? `/page/${page}` : "") + ".html";
    }

    async popularBase(page) {
        return this.parseList(await this.getDoc(`/index.php/vod/show2/by/hits/id/100${page > 1 ? `/page/${page}` : ""}.html`));
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        await statusRefresh(this.client);
        // 분류 없는 최신 목록 주소는 사이트에서 열리지 않아, 첫 화면(오늘의 핫업데이트 + 분류별 최신)을 쓴다
        const r = this.parseList(await this.getDoc("/"));
        return { list: page > 1 ? [] : r.list, hasNextPage: false };
    }

    async searchBase(query, page, filters) {
        if (query && query.trim()) {
            const q = encodeURIComponent(query.trim());
            const path = page > 1 ? `/index.php/vod/search/page/${page}/wd/${q}.html` : `/index.php/vod/search.html?wd=${q}`;
            return this.parseList(await this.getDoc(path));
        }
        let type = "";
        let sort = "time";
        for (const f of filters || []) {
            if (f.type_name !== "SelectFilter") continue;
            if (f.param === "type") type = TYPES[f.state || 0][1];
            if (f.param === "sort") sort = SORTS[f.state || 0][1];
        }
        if (!type) return sort === "hits" ? this.popularBase(page) : this.getLatestUpdates(page);
        return this.parseList(await this.getDoc(this.showPath(type, sort, page)));
    }

    parseList({ doc, base }) {
        const main = doc.selectFirst(".mobile-main") || doc;
        const seen = {};
        const list = [];
        for (const box of main.select(".movie-list-item, .vod-search-list")) {
            const a = box.selectFirst("a[href*='/vod/detail/id/']");
            if (!a) continue;
            const link = this.toPath(a.attr("href"));
            if (!link || seen[link]) continue;
            const t = box.selectFirst(".movie-title");
            const name = ((t && (t.attr("title") || t.text)) || "").trim();
            if (!name) continue;
            seen[link] = true;
            list.push({ name, imageUrl: this.thumbOf(box, base), link });
        }
        return { list, hasNextPage: this.hasNextPage(doc) };
    }

    thumbOf(box, base) {
        const lazy = box.selectFirst(".movie-post-lazyload");
        if (!lazy) {
            const img = box.selectFirst("img");
            return img ? this.resolveUrl(`${base}/`, img.attr("src")) : "";
        }
        const d = lazy.attr("data-original");
        if (d && /^https?:/.test(d)) return d;
        const m = /url\(['"]?([^'")]+)/.exec((lazy.attr("style") || "").replace(/&quot;/g, "\""));
        return m && /^https?:/.test(m[1]) ? m[1] : "";
    }

    hasNextPage(doc) {
        const cur = doc.selectFirst("#page .page-current");
        const curNum = cur ? parseInt(cur.text.trim(), 10) : NaN;
        if (isNaN(curNum)) return false;
        let max = 0;
        for (const a of doc.select("#page a[href]")) {
            const m = /\/page\/(\d+)/.exec(a.attr("href"));
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return max > curNum;
    }

    // ================= 상세 / 회차 =================
    async getDetail(url) {
        const { doc, base } = await this.getDoc(this.toPath(url));
        const title = doc.selectFirst("h1.movie-title");
        const poster = doc.selectFirst(".poster img");
        const sum = doc.selectFirst("#sum_tag");
        const boxes = doc.select("#tagContent .play_list_box");
        const lists = boxes.length ? boxes : doc.select(".content_playlist");
        const tabs = doc.select("#tag .swiper-slide, #tag a").map((e) => e.text.trim());
        const episodes = [];
        const seen = {};
        lists.forEach((box, bi) => {
            const prefix = lists.length > 1 ? `[${tabs[bi] || `서버 ${bi + 1}`}] ` : "";
            const links = box.select("a[href*='/vod/play/']");
            links.forEach((a, i) => {
                const path = this.toPath(a.attr("href"));
                if (!path || seen[path]) return;
                seen[path] = true;
                const label = a.text.trim() || "바로보기";
                const d = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(label);
                // 망가요미는 이름 맨 앞 숫자를 회차 번호로 써서 "26/10/02"처럼 연도로 시작하면 같은 해 회차를 중복으로 숨긴다
                // → 날짜·특집처럼 회차 번호가 없는 이름은 순번을 붙임 (가장 오래된 회차가 1)
                const hasNo = /\d+\s*(?:화|회)/.test(label) && !d;
                const name = hasNo ? label : `${links.length - i}회 · ${label}`;
                episodes.push({
                    name: prefix + name,
                    url: path,
                    dateUpload: d ? String(Date.UTC(2000 + +d[1], +d[2] - 1, +d[3]) - 9 * 3600000) : null,
                });
            });
        });
        return {
            name: title ? title.text.trim() : "",
            imageUrl: poster ? this.resolveUrl(`${base}/`, poster.attr("src")) : "",
            description: sum ? sum.text.trim() : "",
            author: doc.select("p.starLink a").map((e) => e.text.trim()).join(", "),
            genre: doc.select(".scroll-content a").map((e) => e.text.trim()).filter((t) => t),
            status: 5,
            link: `${base}${this.toPath(url)}`,
            episodes,
        };
    }

    // ================= 재생 =================
    async getVideoList(url) {
        const { html, base } = await this.getPage(this.toPath(url));
        const m = /var\s+player_\w+\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
        let media = null;
        if (m) {
            try {
                const o = JSON.parse(m[1]);
                media = this.decodeUrl(String(o.url || ""), Number(o.encrypt) || 0);
            } catch (e) {
                media = null;
            }
        }
        if (!media || !MEDIA_RE.test(media)) {
            const any = MEDIA_RE.exec(String(html).replace(/\\\//g, "/"));
            if (!any) throw new Error(`영상 주소를 찾지 못했습니다: ${base}${this.toPath(url)}`);
            media = any[0];
        }
        const q = media.includes(".m3u8") ? "티비착 (HLS)" : "티비착";
        const hd = (ref) => ({ "User-Agent": UA, "Referer": ref, "Origin": ref.replace(/\/$/, "") });
        return [
            { url: media, originalUrl: media, quality: q, headers: hd(PLAYER_REFERER) },
            { url: media, originalUrl: media, quality: `${q} (대체)`, headers: hd(`${base}/`) },
        ];
    }

    decodeUrl(raw, encrypt) {
        try {
            if (encrypt === 1) return decodeURIComponent(raw);
            if (encrypt === 2) return decodeURIComponent(this.b64(raw));
        } catch (e) {
            return raw;
        }
        return raw;
    }

    b64(s) {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let out = "";
        let bits = 0;
        let val = 0;
        for (const ch of String(s).replace(/[^A-Za-z0-9+/]/g, "")) {
            val = (val << 6) | abc.indexOf(ch);
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((val >> bits) & 0xff);
            }
        }
        return out;
    }

    // ================= 필터 / 설정 =================
    baseFilterList() {
        const sel = (name, param, pairs) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: pairs.map((p) => ({ type_name: "SelectOption", name: p[0], value: p[1] })),
        });
        return [
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용" },
            sel("분류", "type", TYPES),
            sel("정렬", "sort", SORTS),
        ];
    }

    getFilterList() {
        return statusFilters("tvchak", this.getBaseUrl(), this.autoOn()).concat(this.baseFilterList());
    }

    async getPopular(page) {
        await statusRefresh(this.client);
        return this.popularBase(page);
    }

    async search(query, page, filters) {
        await statusRefresh(this.client);
        return this.searchBase(query, page, (filters || []).filter((f) => !(f && f._status)));
    }

    getSourcePreferences() {
        return [{
            key: "tvchak_domain",
            editTextPreference: {
                title: "티비착 주소 직접 지정 (선택)",
                summary: "비워 두면 자동으로 찾은 주소나 기본 주소(https://tvchak208.com)를 사용합니다.",
                value: "",
                dialogTitle: "티비착 주소",
                dialogMessage: "tvchak숫자.com 형식의 HTTPS 주소만 사용됩니다.",
            },
        }, {
            key: "tvchak_auto_on",
            switchPreferenceCompat: {
                title: "도메인 자동 찾기",
                summary: "접속이 안 되면 tvchak 번호 주소(현재 번호 -5 ~ +30)를 찾아 자동 변경",
                value: true,
            },
        }];
    }

    // ================= 유틸 =================
    toPath(href) {
        if (!href) return "";
        const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(href.trim());
        if (m) return m[1] || "/";
        return href.startsWith("/") ? href.trim() : `/${href.trim()}`;
    }

    resolveUrl(base, target) {
        const t = (target || "").trim();
        if (!t) return "";
        if (/^https?:\/\//.test(t)) return t;
        if (t.startsWith("//")) return `https:${t}`;
        const origin = (/^(https?:\/\/[^/]+)/.exec(base) || [null, ""])[1];
        return t.startsWith("/") ? origin + t : origin + "/" + t;
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
