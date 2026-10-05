const mangayomiSources = [{
    "name": "고고티비",
    "lang": "ko",
    "baseUrl": "https://gogotv2.xyz",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": true,
    "version": "0.1.13",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/gogotv.js"
}];

// Aniyomi GogoTV.kt(고고티비)를 망가요미용으로 옮긴 소스
const DEFAULT_BASE_URL = "https://gogotv2.xyz";
const DOMAIN_RE = /^https:\/\/gogotv\d+\.xyz$/;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const PLAYER_HINT = /(?:mode\.php|player|embed|\/v\/|\/e\/|[?&]key=)/i;
const MEDIA_RE = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/i;

const CATEGORIES = [
    ["드라마", "list-drama"], ["영화", "list-movie"], ["예능", "list-vraiety"],
    ["TV프로", "list-tvshow"], ["음악프로", "list-music"], ["애니", "list-animation"],
];
const SORTS = [["업데이트순", "1"], ["주간인기순", "2"], ["월간인기순", "3"], ["전체인기순", "4"]];
const COUNTRIES = [
    ["전체", ""], ["한국", "1"], ["미국", "2"], ["중국", "3"], ["홍콩", "4"],
    ["대만", "5"], ["일본", "6"], ["영국", "7"], ["프랑스", "8"],
];

const RULE_SIZES = [CATEGORIES.length, SORTS.length, COUNTRIES.length];

// 카드의 "제19회 26/10/04" · "E344 26/10/04" 에서 최근 방영일을 "10.04" 로.
// 최종회이거나 마지막 방영이 오래된(종영으로 보이는) 작품은 붙이지 않음
function airLabel(date) {
    const t = String(date || "");
    if (t.includes("최종")) return "";
    const m = /(\d{2})\/(\d{2})\/(\d{2})/.exec(t);
    if (!m) return "";
    if (Date.now() - airAt(t) > 21 * 86400000) return "";
    return `${m[2]}.${m[3]}`;
}

// "제19회 26/10/04" → 한국시간 그날 0시 (없으면 0)
function airAt(text) {
    const m = /(\d{2})\/(\d{2})\/(\d{2})/.exec(String(text || ""));
    return m ? Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3600000 : 0;
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

    getBaseUrl() {
        let custom = "";
        try {
            custom = (new SharedPreferences().get("gogotv_domain") || "").trim().replace(/\/+$/, "");
        } catch (e) {
            custom = "";
        }
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    headers(referer) {
        return { "User-Agent": UA, "Referer": referer || `${this.getBaseUrl()}/` };
    }

    async getDoc(path) {
        const base = this.getBaseUrl();
        const url = path.startsWith("http") ? path : base + path;
        await siteWait();
        const res = await this.client.get(url, this.headers());
        return { doc: new Document(res.body), base: base };
    }

    listPath(cat, sort, country, page) {
        const params = [];
        if (country) params.push(`country=${country}`);
        if (sort) params.push(`o=${sort}`);
        if (page > 1) params.push(`page=${page}`);
        return `/${cat}${params.length ? "?" + params.join("&") : ""}`;
    }

    // ================= 목록 =================
    async popularBase(page) {
        const saved = ruleRead("gogotv", true, RULE_SIZES);
        if (saved) return this.filterPage(page, saved);
        return this.parseList(await this.getDoc(this.listPath("list-drama", "2", "", page)));
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        const saved = ruleRead("gogotv", false, RULE_SIZES);
        if (saved) return this.filterPage(page, saved);
        return this.parseList(await this.getDoc(this.listPath("list-drama", "1", "", page)));
    }

    async searchBase(query, page, filters) {
        // 사이트 작품 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
        const byUrl = /^https?:\/\/gogotv\d+\.xyz\/player\/([A-Za-z0-9]+)/.exec((query || "").trim());
        if (byUrl) {
            const link = `/player/${byUrl[1]}`;
            const d = await this.getDetail(link);
            return { list: d.name ? [{ name: d.name, imageUrl: d.imageUrl, link }] : [], hasNextPage: false };
        }
        if (query && query.trim()) {
            // 사이트 검색창과 같은 주소: /search/검색어 (?page=N)
            const q = encodeURIComponent(query.trim());
            return this.parseList(await this.getDoc(`/search/${q}${page > 1 ? `?page=${page}` : ""}`));
        }
        const st = (i) => {
            const f = filters && filters[i];
            return (f && f.state) || 0;
        };
        const idx = [st(0), st(1), st(2)];
        const ruleF = (filters || []).find((f) => f && f.name === RULE_NAME);
        ruleApply("gogotv", (ruleF && ruleF.state) || 0, idx);
        return this.filterPage(page, idx);
    }

    // idx = [분류, 정렬, 지역] 선택 번호
    async filterPage(page, idx) {
        return this.parseList(await this.getDoc(
            this.listPath(CATEGORIES[idx[0]][1], SORTS[idx[1]][1], COUNTRIES[idx[2]][1], page)));
    }

    // 검색 결과: li > .search-page(포스터·링크) + .view-floor2-lf-cont .tit(제목, 검색어 강조 표시 포함)
    parseSearch({ doc, base }) {
        const seen = {};
        const list = [];
        const yearRe = /\s*\((?:19|20)\d{2}\)\s*$/;
        for (const li of doc.select("li")) {
            if (li.select(".search-page").length === 0) continue;
            const a = li.selectFirst(".search-page a[href*='/player/']");
            if (!a || !a.attr("href")) continue;
            const link = this.toPath(a.attr("href"));
            const t = li ? li.selectFirst(".view-floor2-lf-cont .tit") : null;
            const name = t ? t.text.trim() : "";
            if (!link || !name || seen[link]) continue;
            seen[link] = true;
            const img = a.selectFirst("img");
            const dateNode = li ? li.selectFirst(".date") : null;
            const air = airLabel(dateNode ? dateNode.text : "");
            list.push({
                name: air ? `${name.replace(yearRe, "")} · ${air}` : name,
                imageUrl: img ? this.resolveUrl(`${base}/`, img.attr("src")) : "",
                link,
            });
        }
        return { list, hasNextPage: this.hasNextPage(doc) };
    }

    parseList({ doc, base }) {
        // 검색 결과 화면은 모양이 달라 따로 읽음
        // (망가요미의 selectFirst 는 못 찾아도 빈 요소를 돌려주므로 개수로 판단)
        if (doc.select(".search-page").length > 0) return this.parseSearch({ doc, base });
        const seen = {};
        const list = [];
        for (const dl of doc.select(".itemLish-cont dl, .modList-ul dl, .view-floor3 .item dl")) {
            const a = dl.selectFirst("a[href*='/player/']");
            if (!a) continue;
            const link = this.toPath(a.attr("href"));
            if (!link || seen[link]) continue;
            const img = dl.selectFirst("img");
            const titleNode = dl.selectFirst(".tit");
            const name = ((titleNode && titleNode.text) || (img && img.attr("alt")) || "").trim();
            if (!name) continue;
            seen[link] = true;
            // 방영 중이면 제목 뒤에 최근 방영일 (겹치는 "(2026)" 연도는 뺌),
            // 방영이 끝났으면 제목 뒤에 연도 (사이트 제목에 없으면 마지막 방영 연도)
            const date = dl.selectFirst(".date") ? dl.selectFirst(".date").text : "";
            const air = airLabel(date);
            const yearRe = /\s*\((?:19|20)\d{2}\)\s*$/;
            const d = /(\d{2})\/\d{2}\/\d{2}/.exec(date);
            const shown = air ? `${name.replace(yearRe, "")} · ${air}` : !yearRe.test(name) && d ? `${name} (20${d[1]})` : name;
            list.push({ name: shown, imageUrl: img ? this.resolveUrl(`${base}/`, img.attr("src")) : "", link: link });
        }
        return { list: list, hasNextPage: this.hasNextPage(doc) };
    }

    hasNextPage(doc) {
        const cur = doc.selectFirst(".paging a.on");
        const curNum = cur ? parseInt(cur.text.trim(), 10) : NaN;
        if (isNaN(curNum)) return false;
        let max = 0;
        for (const a of doc.select(".paging a[href]")) {
            const m = /[?&]page=(\d+)/.exec(a.attr("href"));
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return max > curNum;
    }

    // ================= 상세 / 회차 =================
    async getDetail(url) {
        const { doc, base } = await this.getDoc(url);
        const titleNode = doc.selectFirst(".view-floor2-lf-cont .tit") || doc.selectFirst(".view-floor2-tit");
        const poster = doc.selectFirst(".view-floor2-lf-img img");
        const plotNode = doc.selectFirst(".view-floor2-lf-cont .cont");
        const info = doc.select(".view-floor2-lf-cont .list .right").map((e) => e.text.trim())
            .filter((t) => t && !t.includes(","));
        const cast = doc.select(".view-floor2-lf-cont .list .blue a").map((e) => e.text.trim()).join(", ");

        const links = [];
        const seen = {};
        for (const li of doc.select(".view-floor1-rt-cont li")) {
            const a = li.selectFirst("p.left a[href]") || li.selectFirst("a[href]");
            if (!a) continue;
            const href = this.resolveUrl(`${base}/`, a.attr("href"));
            if (!href || seen[href]) continue;
            seen[href] = true;
            // 아이콘 글꼴 문자·탭 제거
            const label = a.text.replace(/[\ue000-\uf8ff]/g, "").replace(/\s+/g, " ").trim() || "바로보기";
            const at = airAt(label);
            links.push({ name: label, url: href, dateUpload: at ? String(at) : null });
        }

        // 방영 중/종영 판단은 목록 카드와 같은 기준: 가장 최근 회차가 최종회가 아니고 21일 안이면 방영 중
        const period = info.find((t) => t.includes("~"));
        const latest = Math.max(0, ...links.map((l) => Number(l.dateUpload) || 0));
        const newest = latest ? links.find((l) => Number(l.dateUpload) === latest) : null;
        const air = newest ? airLabel(newest.name) : "";
        const status = air ? 0 : latest || period ? 1 : 5;
        // 제목도 목록 카드와 똑같이: 방영 중 "제목 · 10.04" (겹치는 연도는 뺌), 끝났으면 "제목 (2026)"
        // (사이트 제목에 연도가 없으면 방영 시작 연도, 그것도 없으면 마지막 방영 연도)
        // — 망가요미는 서재 작품 제목도 업데이트 때마다 새로 받으므로 날짜가 따라 바뀜
        const rawName = titleNode ? titleNode.text.trim() : "";
        const yearRe = /\s*\((?:19|20)\d{2}\)\s*$/;
        let detailName = rawName;
        if (air) {
            detailName = `${rawName.replace(yearRe, "")} · ${air}`;
        } else if (rawName && !yearRe.test(rawName)) {
            const sy = /((?:19|20)\d{2})년/.exec(period || "");
            const ly = newest ? /(\d{2})\/\d{2}\/\d{2}/.exec(newest.name) : null;
            if (sy) detailName = `${rawName} (${sy[1]})`;
            else if (ly) detailName = `${rawName} (20${ly[1]})`;
        }
        let head = "";
        if (latest) {
            const k = new Date(latest + 9 * 3600000);
            const pad = (n) => String(n).padStart(2, "0");
            const day = "일월화수목금토"[k.getUTCDay()];
            const st = status === 0 ? "방영 중 · " : status === 1 ? "종영 · " : "";
            head = `${st}최근 방영: ${k.getUTCFullYear()}.${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())} (${day})`;
        }

        return {
            name: detailName,
            imageUrl: poster ? this.resolveUrl(`${base}/`, poster.attr("src")) : "",
            description: [head].concat(info, plotNode ? [plotNode.text.trim()] : []).filter((t) => t).join("\n\n"),
            author: cast,
            genre: [],
            status,
            link: url,
            episodes: links,
        };
    }

    // ================= 재생 =================
    // 회차 링크(외부 영상 사이트)에서 시작해 새로고침 태그·스크립트 이동·iframe을 따라가며
    // 각 페이지 글자 안에서 영상 주소를 찾는다 (망가요미에는 숨은 브라우저가 없음)
    async getVideoList(url) {
        const base = this.getBaseUrl();
        const trail = [];
        const found = await this.crawl(url, `${base}/`, 0, {}, trail);
        if (!found) {
            throw new Error(`영상 주소를 찾지 못했습니다. 지나간 페이지: ${trail.join(" → ") || url}`);
        }

        const origin = (/^(https?:\/\/[^/]+)/.exec(found.referer) || [null, ""])[1];
        const headers = { "User-Agent": UA, "Referer": found.referer };
        if (origin) headers["Origin"] = origin;
        const quality = found.url.includes(".m3u8") ? "고고티비 (HLS)" : "고고티비";
        return qualitySort("gogotv_quality", await hlsExpand(this.client, found.url, quality, headers));
    }

    async crawl(url, referer, depth, visited, trail) {
        if (depth > 3 || visited[url] || Object.keys(visited).length >= 12) return null;
        visited[url] = true;

        let body;
        try {
            const res = await this.client.get(url, this.headers(referer));
            body = String(res.body || "");
            trail.push(`${this.shortUrl(url)}(${res.statusCode})`);
        } catch (e) {
            trail.push(`${this.shortUrl(url)}(오류)`);
            return null;
        }

        const media = this.findMedia(body);
        if (media) return { url: media, referer: url };

        for (const next of this.nextTargets(body, url)) {
            const found = await this.crawl(next, url, depth + 1, visited, trail);
            if (found) return found;
        }
        return null;
    }

    // 다음에 열어 볼 주소: 새로고침 태그, 스크립트 이동, iframe(src·data-src)
    nextTargets(body, pageUrl) {
        const out = [];
        const add = (u) => {
            if (/^(about|javascript|data):/i.test((u || "").trim())) return;
            const abs = this.resolveUrl(pageUrl, (u || "").replace(/&amp;/g, "&"));
            if (/^https?:\/\//.test(abs) && !out.includes(abs)) out.push(abs);
        };
        const text = body.replace(/\\\//g, "/");
        let m;
        const meta = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/gi;
        while ((m = meta.exec(text)) !== null) add(m[1]);
        const js = /(?:location\.href|location\.replace|location\.assign|window\.location|document\.location|top\.location)\s*(?:=|\()\s*["']([^"']+)["']/gi;
        while ((m = js.exec(text)) !== null) add(m[1]);
        // 지연 로딩(data-src)을 먼저 보고, 자리표시(about:blank 등)는 건너뜀
        const tags = text.match(/<iframe\b[^>]*>/gi) || [];
        for (const tag of tags) {
            const lazy = /\sdata-src=["']([^"']+)["']/i.exec(tag);
            const src = /\ssrc=["']([^"']+)["']/i.exec(tag);
            for (const cand of [lazy, src]) {
                if (cand && !/^(about|javascript|data):/i.test(cand[1])) add(cand[1]);
            }
        }
        // window.open, 링크, 폼 이동
        const open = /window\.open\(\s*["']([^"']+)["']/gi;
        while ((m = open.exec(text)) !== null) add(m[1]);
        // 자동 제출 폼 (send5video go.php → mode.php?key=...): 숨은 입력값을 붙여 주소로 만든다
        const forms = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
        while ((m = forms.exec(text)) !== null) {
            const action = /\saction=["']([^"']*)["']/i.exec(m[1]);
            const params = [];
            const inputs = m[2].match(/<input\b[^>]*>/gi) || [];
            for (const tag of inputs) {
                const name = /\sname=["']([^"']+)["']/i.exec(tag);
                const value = /\svalue=["']([^"']*)["']/i.exec(tag);
                if (name) params.push(`${encodeURIComponent(name[1])}=${encodeURIComponent((value ? value[1] : "").replace(/&amp;/g, "&"))}`);
            }
            const target = action && action[1] ? action[1] : pageUrl;
            add(params.length ? `${target}${target.includes("?") ? "&" : "?"}${params.join("&")}` : target);
        }
        // 그래도 없으면 글자 안의 다른 사이트 플레이어 주소(mode.php, player, embed 등)를 후보로
        if (out.length === 0) {
            const host = (/^https?:\/\/([^/?#]+)/.exec(pageUrl) || [null, ""])[1];
            const cands = text.match(/https?:\/\/[^"'\s<>()]+/g) || [];
            const ranked = cands
                .map((u) => u.replace(/&amp;/g, "&"))
                .filter((u) => !/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)(?:[?#]|$)/i.test(u))
                .filter((u) => !/(?:google|youtube|youtu\.be|facebook|twitter|instagram|jsdelivr|cloudflare|jquery|fonts\.)/i.test(u))
                .filter((u) => !u.includes(`//${host}/`) || /[?&](?:key|v|id|url)=/i.test(u))
                .sort((a, b) => (PLAYER_HINT.test(b) ? 1 : 0) - (PLAYER_HINT.test(a) ? 1 : 0));
            for (const u of ranked) add(u);
        }
        return out.slice(0, 8);
    }

    shortUrl(u) {
        const m = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(u || "");
        return m ? (m[1] + m[2]).substring(0, 50) : String(u).substring(0, 50);
    }

    findMedia(html) {
        if (!html) return null;
        const text = html.replace(/\\\//g, "/");
        let m = MEDIA_RE.exec(text);
        if (m) return m[0];
        // base64로 숨긴 주소 (aHR0c... = "http")
        for (const b64 of text.match(/aHR0c[A-Za-z0-9+/_-]{10,}={0,2}/g) || []) {
            m = MEDIA_RE.exec(this.base64Decode(b64));
            if (m) return m[0];
        }
        // eval(function(p,a,c,k,e,d) ...) 로 압축된 스크립트 풀기
        const packed = text.match(/eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\)\)\)?/g) || [];
        for (const p of packed) {
            try {
                m = MEDIA_RE.exec(unpackJs(p).replace(/\\\//g, "/"));
                if (m) return m[0];
            } catch (e) {
                // 다음 스크립트
            }
        }
        return null;
    }

    // atob가 없는 환경을 위한 base64(일반·URL용) → 글자 변환
    base64Decode(s) {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
        let bits = 0;
        let value = 0;
        let out = "";
        for (const ch of clean) {
            const idx = abc.indexOf(ch);
            if (idx < 0) continue;
            value = (value << 6) | idx;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((value >> bits) & 0xff);
            }
        }
        try {
            return decodeURIComponent(escape(out));
        } catch (e) {
            return out;
        }
    }

    // ================= 필터 / 설정 =================
    baseFilterList() {
        const select = (name, items) => ({
            type_name: "SelectFilter",
            name: name,
            state: 0,
            values: items.map(([label, value]) => ({ type_name: "SelectOption", name: label, value: value })),
        });
        // 검색어가 없을 때만 적용 (search()에서 0, 1, 2번 순서로 읽음)
        return [
            select("분류", CATEGORIES),
            select("정렬", SORTS),
            select("지역", COUNTRIES),
        ].concat(ruleFilters("gogotv", RULE_SIZES, ["드라마 · 주간인기순", "드라마 · 업데이트순"],
            (i) => `${CATEGORIES[i[0]][0]} · ${SORTS[i[1]][0]} · ${COUNTRIES[i[2]][0]}`));
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
        return statusFilters("gogotv", this.statusBase(), this.statusAuto()).concat(this.baseFilterList());
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
            key: "gogotv_domain",
            editTextPreference: {
                title: "고고티비 주소 직접 지정 (선택)",
                summary: "비워 두면 기본 주소(https://gogotv2.xyz)를 사용합니다. 주소가 바뀌면 여기에 새 주소를 넣으세요.",
                value: "",
                dialogTitle: "고고티비 주소",
                dialogMessage: "gogotv숫자.xyz 형식의 HTTPS 주소만 사용됩니다.",
            },
        }, qualityPreference("gogotv_quality")];
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
        if (t.startsWith("/")) return origin + t;
        const path = base.replace(/[?#].*$/, "");
        return path.substring(0, path.lastIndexOf("/") + 1) + t;
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
