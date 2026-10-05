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
    "version": "0.1.17",
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

const RULE_SIZES = [TYPES.length, SORTS.length];

// ---------- 목록 카드용 연도/방영일 저장 ----------
const ONGOING_DAYS = 21;
const AIR_TTL_MS = 6 * 3600000;
const ENDED_TTL_MS = 7 * 86400000;

// 저장된 시리즈 연도 (사이트 표기)
function seriesYear(p, id) {
    const y = String(p.getString(`air_${id}`, "") || "").split("|")[2] || "";
    return /^(?:19|20)\d{2}$/.test(y) ? y : "";
}

// 저장된 최근 방영일 [방영일, 읽은 시각]. 없으면 [0, 0]
function airOf(p, id) {
    const v = String(p.getString(`air_${id}`, "") || "").split("|");
    return [Number(v[0]) || 0, Number(v[1]) || 0];
}

// 회차 이름 "26/10/02" → 한국시간 그날 0시
function airDate(label) {
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(String(label || "").trim());
    return m ? Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3600000 : 0;
}

// 상세 페이지에서 영화 연도 또는 시리즈 최근 방영일을 읽어 저장
function saveInfo(p, id, doc) {
    let links = doc.select("#tagContent a[href*='/vod/play/'], .content_playlist a[href*='/vod/play/']");
    if (!links.length) links = doc.select("a[href*='/vod/play/']");
    const seen = {};
    const labels = [];
    for (const a of links) {
        const h = a.attr("href");
        if (seen[h]) continue;
        seen[h] = true;
        labels.push(a.text.trim());
    }
    const y = doc.selectFirst(".scroll-content a[href*='/year/']");
    const year = y ? y.text.trim() : "";
    if (labels.length <= 1) {
        p.setString(`year_${id}`, /^(?:19|20)\d{2}$/.test(year) ? year : "-");
    } else {
        // 시리즈는 "-" 로 표시하고, 최근 방영일·읽은 시각·연도는 따로 저장
        const latest = Math.max(0, ...labels.map(airDate));
        p.setString(`year_${id}`, "-");
        p.setString(`air_${id}`, `${latest}|${Date.now()}|${year}`);
    }
}

// ---------- 접속 속도 제한 · 화질 나누기 ----------
// 사이트로 가는 요청 사이에 최소 간격 (한꺼번에 많이 요청하면 사이트가 403으로 막음)
let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// HLS 마스터 목록에 화질이 여러 개면 각각 따로 고를 수 있게 나눔. 하나뿐이거나 읽지 못하면 그대로
async function hlsExpand(client, url, label, headers) {
    const one = [{ url, originalUrl: url, quality: label, headers }];
    if (!url.includes(".m3u8")) return one;
    let body = "";
    try {
        const res = await client.get(url, headers);
        if (Number(res.statusCode) >= 400) return one;
        body = String(res.body || "").replace(/\r/g, "");
    } catch (e) {
        return one;
    }
    const seen = {};
    const variants = [];
    const re = /#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)/g;
    let m;
    while ((m = re.exec(body))) {
        const h = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
        if (!h || seen[h[1]]) continue;
        seen[h[1]] = true;
        let u = m[2].trim();
        if (!/^https?:\/\//.test(u)) {
            u = u.startsWith("/") ? (/^(https?:\/\/[^/]+)/.exec(url) || [null, ""])[1] + u : url.replace(/[^/]*(?:\?.*)?$/, "") + u;
        }
        variants.push({ h: Number(h[1]), u });
    }
    if (variants.length < 2) return one;
    variants.sort((a, b) => b.h - a.h);
    return [{ url, originalUrl: url, quality: `${label} 자동`, headers }]
        .concat(variants.map((v) => ({ url: v.u, originalUrl: v.u, quality: `${label} ${v.h}p`, headers })));
}

// 설정의 선호 화질을 맨 앞으로
function qualitySort(prefKey, list) {
    let want = "자동";
    try {
        const v = new SharedPreferences().get(prefKey);
        want = QUALITY_CHOICES[Number(v)] || (QUALITY_CHOICES.includes(v) ? v : "자동");
    } catch (e) {
        want = "자동";
    }
    return list.filter((x) => x.quality.endsWith(` ${want}`)).concat(list.filter((x) => !x.quality.endsWith(` ${want}`)));
}

function qualityPreference(key) {
    return {
        key,
        listPreference: {
            title: "선호 화질",
            summary: "영상이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다.",
            valueIndex: 0,
            entries: QUALITY_CHOICES,
            entryValues: QUALITY_CHOICES,
        },
    };
}

// ---------- 인기/최신 탭 규칙 (필터 조건을 탭에 저장) ----------
const RULE_CHOICES = [
    "저장하지 않음 (필터 결과만 보기)",
    "현재 조건을 인기 탭에 저장",
    "현재 조건을 최신 탭에 저장",
    "인기 탭을 기본값으로 복원",
    "최신 탭을 기본값으로 복원",
    "두 탭 모두 기본값으로 복원",
];
const RULE_NAME = "인기/최신 탭 규칙";

// 저장 값은 필터 선택 번호를 쉼표로 이은 문자열. 없거나 맞지 않으면 null (= 기본값)
function ruleRead(prefix, popular, sizes) {
    let raw = "";
    try {
        raw = new SharedPreferences().getString(`${prefix}_${popular ? "pop" : "latest"}_rule`, "") || "";
    } catch (e) {
        return null;
    }
    if (!raw) return null;
    const idx = raw.split(",").map((x) => parseInt(x, 10));
    if (idx.length !== sizes.length || idx.some((v, i) => !(v >= 0 && v < sizes[i]))) return null;
    return idx;
}

function ruleApply(prefix, rule, idx) {
    try {
        const p = new SharedPreferences();
        const pop = `${prefix}_pop_rule`;
        const latest = `${prefix}_latest_rule`;
        const v = idx.join(",");
        if (rule === 1) p.setString(pop, v);
        else if (rule === 2) p.setString(latest, v);
        else if (rule === 3) p.setString(pop, "");
        else if (rule === 4) p.setString(latest, "");
        else if (rule === 5) {
            p.setString(pop, "");
            p.setString(latest, "");
        }
    } catch (e) {
        // 저장 실패는 무시 (필터 결과는 그대로 보여 줌)
    }
}

function ruleFilters(prefix, sizes, defaults, text) {
    const pop = ruleRead(prefix, true, sizes);
    const latest = ruleRead(prefix, false, sizes);
    return [
        { type_name: "SeparatorFilter" },
        { type_name: "HeaderFilter", name: `현재 인기: ${pop ? text(pop) : defaults[0] + " (기본)"}` },
        { type_name: "HeaderFilter", name: `현재 최신: ${latest ? text(latest) : defaults[1] + " (기본)"}` },
        {
            type_name: "SelectFilter", name: RULE_NAME, param: "rule", state: 0,
            values: RULE_CHOICES.map((c, i) => ({ type_name: "SelectOption", name: c, value: String(i) })),
        },
    ];
}

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
        await siteWait();
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
        const saved = ruleRead("tvchak", false, RULE_SIZES);
        if (saved) return this.withYears(await this.filterPage(page, saved), TYPES[saved[0]][1] === "1");
        return this.withYears(await this.latestBase(page));
    }

    // 분류 없는 최신 목록 주소는 사이트에서 열리지 않아, 첫 화면(오늘의 핫업데이트 + 분류별 최신)을 쓴다
    async latestBase(page) {
        const r = this.parseList(await this.getDoc("/"));
        return { list: page > 1 ? [] : r.list, hasNextPage: false };
    }

    async searchBase(query, page, filters) {
        // 사이트 작품 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
        const byUrl = /^https?:\/\/tvchak\d+\.com(?:\/.*?)?\/vod\/(?:detail|play)\/id\/(\d+)/.exec((query || "").trim());
        if (byUrl) {
            const link = `/index.php/vod/detail/id/${byUrl[1]}.html`;
            const { doc, base } = await this.getDoc(link);
            const t = doc.selectFirst("h1.movie-title");
            const img = doc.selectFirst(".poster img");
            const name = t ? t.text.trim() : "";
            return { list: name ? [{ name, imageUrl: img ? this.resolveUrl(`${base}/`, img.attr("src")) : "", link }] : [], hasNextPage: false };
        }
        if (query && query.trim()) {
            const q = encodeURIComponent(query.trim());
            const path = page > 1 ? `/index.php/vod/search/page/${page}/wd/${q}.html` : `/index.php/vod/search.html?wd=${q}`;
            return this.parseList(await this.getDoc(path));
        }
        const idx = [0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (f.type_name !== "SelectFilter") continue;
            if (f.param === "type") idx[0] = f.state || 0;
            if (f.param === "sort") idx[1] = f.state || 0;
            if (f.param === "rule") rule = f.state || 0;
        }
        ruleApply("tvchak", rule, idx);
        return this.filterPage(page, idx);
    }

    // idx = [분류, 정렬] 선택 번호
    async filterPage(page, idx) {
        const type = TYPES[idx[0]][1];
        const sort = SORTS[idx[1]][1];
        if (!type) return sort === "hits" ? this.popularBase(page) : this.latestBase(page);
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

    /**
     * 목록 카드의 영화 제목 옆에 개봉 연도를 붙임.
     * 목록 페이지에는 연도가 없어서, 영화 분류 목록일 때 각 작품 상세 페이지에서 연도를 읽어 폰에 저장해 두고
     * (한 번 읽은 작품은 다시 읽지 않음) 모든 목록에서 저장된 연도를 붙인다.
     */
    // 목록 카드 제목 뒤에 정보를 붙임: 영화와 방영이 끝난 드라마·예능은 연도 "(2024)", 방영 중이면 최근 방영일 " · 10.04".
    // 목록 페이지에는 둘 다 없어서 각 작품 상세 페이지에서 읽어 폰에 저장해 둔다.
    // 영화 연도는 한 번만 읽고, 방영일은 6시간이 지나면 다시 읽는다.
    async withYears(result, movieList) {
        let p;
        try {
            p = new SharedPreferences();
        } catch (e) {
            return result;
        }
        const idOf = (x) => (/\/id\/(\d+)/.exec(x.link) || [])[1];
        const now = Date.now();
        const ids = result.list.map(idOf).filter((id) => id);
        // 처음 보는 작품 먼저, 그다음 방영일이 오래된 시리즈 (영화 목록에서는 시리즈를 다시 읽지 않음)
        const unknown = ids.filter((id) => !p.getString(`year_${id}`, ""));
        // 방영 중인 시리즈는 6시간, 끝난 시리즈는 7일마다 다시 읽음
        const stale = movieList ? [] : ids.filter((id) => {
            const [latest, checked] = airOf(p, id);
            const ttl = now - latest <= ONGOING_DAYS * 86400000 ? AIR_TTL_MS : ENDED_TTL_MS;
            return p.getString(`year_${id}`, "") === "-" && now - checked > ttl;
        });
        const todo = unknown.concat(stale);
        let ok = 0;
        let fail = 0;
        // 한꺼번에 많이 읽으면 사이트(CloudFront)가 접속을 잠시 차단하므로
        // 한 번에 하나씩, 간격을 두고, 목록 한 번에 최대 8개만 읽는다. 막히는 기미가 보이면 즉시 멈춤
        const stopUntil = Number(p.getString("year_pause_until", "0")) || 0;
        const batch = now < stopUntil ? [] : todo.slice(0, 8);
        for (const id of batch) {
            try {
                const { html, res } = await this.getHtml(`/index.php/vod/detail/id/${id}.html`);
                const code = res ? Number(res.statusCode) : 200;
                if (code === 403 || code === 202 || code === 429 || !String(html || "").includes("maccms")) {
                    fail++;
                    // 10분 동안 읽기를 쉼
                    p.setString("year_pause_until", String(Date.now() + 10 * 60000));
                    break;
                }
                saveInfo(p, id, new Document(html));
                ok++;
            } catch (e) {
                fail++;
                break;
            }
            await new Promise((r) => setTimeout(r, 700));
        }
        let years = 0;
        let airs = 0;
        for (const x of result.list) {
            const id = idOf(x);
            const y = id ? p.getString(`year_${id}`, "") : "";
            if (/^(?:19|20)\d{2}$/.test(y)) {
                if (!x.name.includes(y)) x.name = `${x.name} (${y})`;
                years++;
            } else if (y === "-") {
                const latest = airOf(p, id)[0];
                if (!latest) continue;
                const k = new Date(latest + 9 * 3600000);
                if (now - latest <= ONGOING_DAYS * 86400000) {
                    // 방영 중: 제목 뒤에 최근 방영일
                    const pad = (n) => String(n).padStart(2, "0");
                    x.name = `${x.name} · ${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())}`;
                    airs++;
                } else {
                    // 방영이 끝남: 제목 뒤에 연도 (사이트 표기, 없으면 마지막 방영 연도)
                    const sy = seriesYear(p, id) || String(k.getUTCFullYear());
                    if (!x.name.includes(sy)) x.name = `${x.name} (${sy})`;
                    years++;
                }
            }
        }
        // 필터 화면에 보여 줄 진단
        try {
            p.setString("year_diag", `목록 ${result.list.length}개 · 남은 ${todo.length - ok}개 · 이번에 읽음 ${ok}개${fail ? " · 사이트가 막아 10분 쉼" : ""} · 연도 ${years}개 · 방영일 ${airs}개`);
        } catch (e) {
            // 무시
        }
        return result;
    }

    // ================= 상세 / 회차 =================
    async getDetail(url) {
        const { doc, base } = await this.getDoc(this.toPath(url));
        // 목록 카드에도 같은 연도/방영일이 붙도록 저장
        try {
            const id = (/\/id\/(\d+)/.exec(this.toPath(url)) || [])[1];
            if (id) saveInfo(new SharedPreferences(), id, doc);
        } catch (e) {
            // 저장 실패는 무시
        }
        const title = doc.selectFirst("h1.movie-title");
        const poster = doc.selectFirst(".poster img");
        const sum = doc.selectFirst("#sum_tag");
        const boxes = doc.select("#tagContent .play_list_box");
        const lists = boxes.length ? boxes : doc.select(".content_playlist");
        const tabs = doc.select("#tag .swiper-slide, #tag a").map((e) => e.text.trim());
        const episodes = [];
        const seen = {};
        lists.forEach((box, bi) => {
            // 서버가 여러 개면 서버 이름을 "스캔레이터"로 넣어 앱에서 서버별로 거를 수 있게 함
            const server = lists.length > 1 ? tabs[bi] || `서버 ${bi + 1}` : "";
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
                    name,
                    url: path,
                    scanlator: server,
                    dateUpload: d ? String(Date.UTC(2000 + +d[1], +d[2] - 1, +d[3]) - 9 * 3600000) : null,
                });
            });
        });
        const plot = sum ? sum.text.trim() : "";
        const rawName = title ? title.text.trim() : "";
        let name = rawName;
        let status = 5;
        let description = plot;
        if (episodes.length <= 1) {
            // 영화(회차 1개): 제목 옆에 개봉 연도
            name = this.titleWithYear(rawName, doc);
            status = 1;
        } else {
            // 드라마·예능: 가장 최근 방영일로 방영 중/종영 판단.
            // 제목: 방영 중이면 "제목 · 10.04", 끝났으면 "제목 (2019)" — 망가요미는 서재 작품 제목도 업데이트 때마다 새로 받으므로 날짜가 따라 바뀜
            const dates = episodes.map((e) => Number(e.dateUpload) || 0).filter((t) => t > 0);
            const latest = dates.length ? Math.max(...dates) : 0;
            let head = `총 ${episodes.length}회`;
            if (latest) {
                const ongoing = Date.now() - latest <= 21 * 86400000;
                status = ongoing ? 0 : 1;
                const k = new Date(latest + 9 * 3600000);
                const pad = (n) => String(n).padStart(2, "0");
                const day = "일월화수목금토"[k.getUTCDay()];
                head = `${ongoing ? "방영 중" : "종영"} · 최근 방영: ${k.getUTCFullYear()}.${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())} (${day}) · ${head}`;
                if (ongoing) name = `${rawName} · ${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())}`;
                else {
                    name = this.titleWithYear(rawName, doc);
                    if (name === rawName && !rawName.includes(String(k.getUTCFullYear()))) name = `${rawName} (${k.getUTCFullYear()})`;
                }
            }
            description = [head, plot].filter((t) => t).join("\n\n");
        }
        return {
            name,
            imageUrl: poster ? this.resolveUrl(`${base}/`, poster.attr("src")) : "",
            description,
            author: doc.select("p.starLink a").map((e) => e.text.trim()).join(", "),
            genre: doc.select(".scroll-content a").map((e) => e.text.trim()).filter((t) => t),
            status,
            link: `${base}${this.toPath(url)}`,
            episodes,
        };
    }

    /** 개봉(방영 시작) 연도를 제목 옆에 표시 - 제목에 이미 연도가 있으면 그대로 */
    titleWithYear(name, doc) {
        const y = doc.selectFirst(".scroll-content a[href*='/year/']");
        const year = y ? y.text.trim() : "";
        return /^(?:19|20)\d{2}$/.test(year) && !name.includes(year) ? `${name} (${year})` : name;
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
        const list = await hlsExpand(this.client, media, q, hd(PLAYER_REFERER));
        list.push({ url: media, originalUrl: media, quality: `${q} (대체)`, headers: hd(`${base}/`) });
        return qualitySort("tvchak_quality", list);
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
        ].concat(ruleFilters("tvchak", RULE_SIZES, ["전체 · 인기순", "첫 화면 최신"],
            (i) => `${TYPES[i[0]][0]} · ${SORTS[i[1]][0]}`));
    }

    getFilterList() {
        let diag = "";
        try {
            diag = new SharedPreferences().getString("year_diag", "");
        } catch (e) {
            diag = "";
        }
        const extra = diag ? [{ type_name: "HeaderFilter", name: `🎬 영화 연도: ${diag}`, _status: true }] : [];
        return statusFilters("tvchak", this.getBaseUrl(), this.autoOn()).concat(extra, this.baseFilterList());
    }

    async getPopular(page) {
        await statusRefresh(this.client);
        const saved = ruleRead("tvchak", true, RULE_SIZES);
        if (saved) return this.withYears(await this.filterPage(page, saved), TYPES[saved[0]][1] === "1");
        return this.withYears(await this.popularBase(page));
    }

    async search(query, page, filters) {
        await statusRefresh(this.client);
        // 앱이 돌려준 필터에 param 이 빠져 있을 수 있어 같은 이름의 원래 필터에서 채움
        const base = this.baseFilterList();
        const list = (filters || []).filter((f) => f && !f._status && !(f.type_name === "HeaderFilter" && /^(?:📡|🩺|❌|🛡)/.test(String(f.name || ""))));
        for (const f of list) {
            if (!f.param) {
                const b = base.find((x) => x.name === f.name && x.type_name === f.type_name);
                if (b && b.param) f.param = b.param;
            }
        }
        const typeF = list.find((f) => f.param === "type");
        const isMovie = !query && typeF && TYPES[typeF.state || 0] && TYPES[typeF.state || 0][1] === "1";
        return this.withYears(await this.searchBase(query, page, list), isMovie);
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
        }, qualityPreference("tvchak_quality")];
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
