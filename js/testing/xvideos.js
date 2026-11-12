const mangayomiSources = [{
    "name": "[시험] xVideos",
    "lang": "ko",
    "baseUrl": "https://www.xvideos.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": true,
    "hasCloudflare": false,
    "version": "0.0.1",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "js/testing/xvideos.js"
}];

// xVideos (2026-11-12 구조 확인, 해외에서도 열림 · 보안 확인 없음)
// - 목록: 최신 = 첫 화면 / → /new/{쪽-1} · 이번 달 인기 /best/{yyyy-mm}/{쪽-1} · 분류 /c/{이름-번호}/{쪽-1}
//   카드 .thumb-block (a[href^=/video] · img data-src · 제목은 a[title] 또는 img alt), 다음 쪽 a.next-page
// - 검색: /?k=검색어&sort=relevance|uploaddate|rating|views|length&datef=all|today|week|month&durf=…&quality=…&p={쪽-1}
// - 작품: 화면 글자 안 html5player.setVideoTitle / setVideoHLS(화질 묶음 m3u8) / setVideoUrlHigh·Low(mp4),
//   ld+json uploadDate·duration, 태그 a.is-keyword
// - 사이트의 한국어 목록(/lang/korean)은 사용자 업로드 「유출」류 제목이 섞여 있어 필터에 넣지 않음 (2026-11-12)
const DEFAULT_BASE_URL = "https://www.xvideos.com";
const DOMAIN_RE = /^https:\/\/(?:www\.)?xvideos\d*\.[a-z]{2,8}$/;
const SITE_RE = /^https?:\/\/(?:www\.)?xvideos\d*\.[a-z]{2,8}/;
const LABEL = "xVideos";

// 분류: 값이 "/" 로 시작하면 주소, 아니면 /c/ 분류
const KINDS = [
    ["최신", "/"], ["이번 달 인기", "/best"],
    ["AI", "AI-239"], ["ASMR", "ASMR-229"], ["Amateur", "Amateur-65"], ["Anal", "Anal-12"], ["Arab", "Arab-159"],
    ["Asian", "Asian_Woman-32"], ["Ass", "Ass-14"], ["BBW", "bbw-51"], ["Bi", "Bi_Sexual-62"], ["Big Ass", "Big_Ass-24"],
    ["Big Cock", "Big_Cock-34"], ["Big Tits", "Big_Tits-23"], ["Black", "Black_Woman-30"], ["Blonde", "Blonde-20"],
    ["Blowjob", "Blowjob-15"], ["Brunette", "Brunette-25"], ["Cam Porn", "Cam_Porn-58"], ["Creampie", "Creampie-40"],
    ["Cuckold/Hotwife", "Cuckold-237"], ["Cumshot", "Cumshot-18"], ["Femdom", "Femdom-235"], ["Fisting", "Fisting-165"],
    ["Fucked Up Family", "Fucked_Up_Family-81"], ["Gangbang", "Gangbang-69"], ["Gapes", "Gapes-167"], ["Indian", "Indian-89"],
    ["Interracial", "Interracial-27"], ["Latina", "Latina-16"], ["Lesbian", "Lesbian-26"], ["Lingerie", "Lingerie-83"],
    ["Mature", "Mature-38"], ["Milf", "Milf-19"], ["Oiled", "Oiled-22"], ["Redhead", "Redhead-31"],
    ["Solo", "Solo_and_Masturbation-33"], ["Squirting", "Squirting-56"], ["Stockings", "Stockings-28"], ["Teen", "Teen-13"],
];
const SORTS = [["관련순", "relevance"], ["최신", "uploaddate"], ["평점", "rating"], ["조회", "views"], ["길이", "length"]];
const DATES = [["전체 기간", "all"], ["오늘", "today"], ["이번 주", "week"], ["이번 달", "month"]];
const DURS = [["전체 길이", "allduration"], ["1~3분", "1-3min"], ["3~10분", "3-10min"], ["10분 이상", "10min_more"], ["10~20분", "10-20min"], ["20분 이상", "20min_more"]];
const QUALS = [["전체 화질", "all"], ["HD", "hd"], ["1080p 이상", "1080"]];
const FILTER_DEFS = [["분류", KINDS], ["검색 정렬", SORTS], ["검색 기간", DATES], ["검색 길이", DURS], ["검색 화질", QUALS]];
// 탭 규칙은 분류 한 칸만 저장
const RULE_SIZES = [KINDS.length];
const DEFAULT_POPULAR = [1];
const DEFAULT_LATEST = [0];
const ruleText = (i) => KINDS[i[0]][0];

function first(el, css) {
    const l = el ? el.select(css) : [];
    return l && l.length ? l[0] : null;
}

function unesc(s) {
    return String(s || "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, "\"")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\\\//g, "/");
}

function ymd(ms) {
    const d = new Date(ms + 9 * 3600000).toISOString();
    return `${d.substring(0, 4)}.${d.substring(5, 7)}.${d.substring(8, 10)}`;
}

function count(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
}

// "PT00H12M31S" → "12:31"
function isoDur(s) {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(s || ""));
    if (!m) return "";
    const h = Number(m[1] || 0);
    const mi = Number(m[2] || 0);
    const se = Number(m[3] || 0);
    return (h ? `${h}:${String(mi).padStart(2, "0")}` : `${mi}`) + `:${String(se).padStart(2, "0")}`;
}

let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 300 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// HLS 화질 묶음 → 자동 + 화질별
async function hlsExpand(client, url, label, headers) {
    const one = [{ url, originalUrl: url, quality: label, headers }];
    let body = "";
    try {
        const res = await client.get(url, headers);
        if (Number(res.statusCode) >= 400) return [];
        body = String(res.body || "").replace(/\r/g, "");
    } catch (e) {
        return one;
    }
    if (!body.trim().startsWith("#EXTM3U")) return [];
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
    if (variants.length === 1) return [{ url, originalUrl: url, quality: `${label} ${variants[0].h}p`, headers }];
    if (variants.length < 2) return one;
    variants.sort((a, b) => b.h - a.h);
    return [{ url, originalUrl: url, quality: `${label} 자동 (최대 ${variants[0].h}p)`, headers }]
        .concat(variants.map((v) => ({ url: v.u, originalUrl: v.u, quality: `${label} ${v.h}p`, headers })));
}

function qualitySort(prefKey, list) {
    let want = "자동";
    try {
        const v = new SharedPreferences().get(prefKey);
        want = QUALITY_CHOICES[Number(v)] || (QUALITY_CHOICES.includes(v) ? v : "자동");
    } catch (e) {
        want = "자동";
    }
    const hit = (x) => x.quality.endsWith(` ${want}`) || x.quality.includes(` ${want} `);
    return list.filter(hit).concat(list.filter((x) => !hit(x)));
}

// ---------- 인기/최신 탭 규칙 ----------
const RULE_CHOICES = [
    "저장하지 않음 (필터 결과만 보기)",
    "현재 조건을 인기 탭에 저장",
    "현재 조건을 최신 탭에 저장",
    "인기 탭을 기본값으로 복원",
    "최신 탭을 기본값으로 복원",
    "두 탭 모두 기본값으로 복원",
];
const RULE_NAME = "인기/최신 탭 규칙";

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
        // 저장 실패는 무시
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

// ---------- 앱 기본 User-Agent 사용 (다른 확장과 같은 appClient) ----------
let APP_NO_UA = false;
let APP_ALT = null;
function appClient(raw) {
    const media = /\.(?:m3u8|mp4|ts|m4s|jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
    const fallbackUa = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    const strip = (url, headers) => {
        if (!headers || media.test(String(url || ""))) return headers || {};
        const out = {};
        for (const k in headers) if (k.toLowerCase() !== "user-agent") out[k] = headers[k];
        return out;
    };
    const withUa = (headers) => {
        const out = Object.assign({}, headers || {});
        if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) out["User-Agent"] = fallbackUa;
        return out;
    };
    const alt = () => {
        if (!APP_ALT) {
            try {
                APP_ALT = new Client({ persistentConnection: false, noProxy: true, timeout: 25, connectTimeout: 10 });
            } catch (e) {
                APP_ALT = null;
            }
        }
        return APP_ALT;
    };
    const send = async (call, url, headers) => {
        if (APP_NO_UA || media.test(String(url || ""))) {
            try {
                return await call(raw, url, APP_NO_UA ? withUa(headers) : headers || {});
            } catch (e) {
                const c = alt();
                if (!c) throw e;
                return call(c, url, withUa(headers));
            }
        }
        let res;
        try {
            res = await call(raw, url, strip(url, headers));
        } catch (e) {
            try {
                const again = await call(raw, url, withUa(headers));
                APP_NO_UA = true;
                return again;
            } catch (e2) {
                const c = alt();
                if (!c) throw e;
                try {
                    return await call(c, url, withUa(headers));
                } catch (e3) {
                    throw e;
                }
            }
        }
        if (res && res.statusCode === 403) {
            try {
                const again = await call(raw, url, withUa(headers));
                if (again && again.statusCode && again.statusCode < 400) {
                    APP_NO_UA = true;
                    return again;
                }
            } catch (e) {}
        }
        return res;
    };
    return {
        get: (url, headers) => send((c, u, h) => c.get(u, h), url, headers),
        post: (url, headers, body) => send((c, u, h) => c.post(u, h, body), url, headers),
    };
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    getBaseUrl() {
        let v = "";
        try {
            v = String(new SharedPreferences().get("xv_domain") || "").trim().replace(/\/+$/, "");
        } catch (e) {
            v = "";
        }
        return DOMAIN_RE.test(v) ? v : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "Referer": `${this.getBaseUrl()}/` };
    }

    async get(url) {
        await siteWait();
        let res = null;
        let err = "";
        try {
            res = await this.client.get(url, this.getHeaders(url));
        } catch (e) {
            err = String((e && e.message) || e).substring(0, 80);
        }
        const shape = String(url).replace(/^https?:\/\//, "").split("?")[0].substring(0, 48);
        if (!res) throw new Error(`xVideos 접속 실패 [${shape} · ${err}]`);
        if (res.statusCode >= 400) {
            const head = String(res.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 60);
            throw new Error(`xVideos 접속 실패 [HTTP ${res.statusCode} · ${shape} · "${head}"]`);
        }
        return String(res.body || "");
    }

    parseList(html) {
        const doc = new Document(html);
        const list = [];
        const seen = {};
        for (const b of doc.select(".thumb-block")) {
            const a = first(b, "a[href*='/video']");
            if (!a) continue;
            const href = a.attr("href").split("#")[0];
            if (!/\/video[.\d]/.test(href) || seen[href]) continue;
            seen[href] = true;
            const t = first(b, ".title a[title]") || first(b, "p.title a") || first(b, ".title[title]");
            const img = first(b, "img");
            let name = t ? (t.attr("title") || t.text) : "";
            if (!name && img) name = img.attr("alt");
            name = unesc(name).replace(/\s+\d+\s*(?:min|sec|h)\s*$/i, "").trim();
            const imageUrl = img ? (img.attr("data-src") || img.attr("src")) : "";
            list.push({ name, imageUrl: /blank|lightbox/.test(imageUrl) ? "" : imageUrl, link: this.getBaseUrl() + href });
        }
        const hasNext = doc.select("a.next-page").length > 0;
        return { list, hasNext };
    }

    /** 분류 번호와 쪽으로 목록 주소 */
    listUrl(kind, page) {
        const v = KINDS[kind][1];
        const base = this.getBaseUrl();
        const p = page - 1;
        // 최신 = 첫 화면, 2쪽부터 /new/1 (/new·/new/0 은 404)
        if (v === "/") return p > 0 ? `${base}/new/${p}` : `${base}/`;
        if (v === "/best") {
            const d = new Date(Date.now() + 9 * 3600000).toISOString();
            const ym = d.substring(0, 7);
            return p > 0 ? `${base}/best/${ym}/${p}` : `${base}/best/${ym}`;
        }
        return p > 0 ? `${base}/c/${v}/${p}` : `${base}/c/${v}`;
    }

    async listPage(kind, page) {
        const { list, hasNext } = this.parseList(await this.get(this.listUrl(kind, page)));
        // 이번 달 인기는 다음 쪽 링크가 없어서 꽉 찬 쪽이면 다음 쪽 있음
        const more = hasNext || (KINDS[kind][1] === "/best" && list.length >= 20);
        return { list, hasNextPage: list.length > 0 && more };
    }

    async getPopular(page) {
        const idx = ruleRead("xv", true, RULE_SIZES) || DEFAULT_POPULAR;
        return this.listPage(idx[0], page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        const idx = ruleRead("xv", false, RULE_SIZES) || DEFAULT_LATEST;
        return this.listPage(idx[0], page);
    }

    async search(query, page, filters) {
        const q = String(query || "").trim();
        // 영상 주소 붙여 넣기 → 그 영상
        const site = /^(?:https?:\/\/)?((?:www\.)?xvideos\d*\.[a-z]{2,8})(\/video[^\s]*)$/i.exec(q);
        if (site) {
            if (page > 1) return { list: [], hasNextPage: false };
            const url = this.getBaseUrl() + site[2].split("#")[0];
            const d = await this.getDetail(url);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: url }], hasNextPage: false };
        }
        const idx = FILTER_DEFS.map(() => 0);
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), FILTER_DEFS[k][1].length - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (q) {
            let url = `${this.getBaseUrl()}/?k=${encodeURIComponent(q)}`;
            if (idx[1]) url += `&sort=${SORTS[idx[1]][1]}`;
            if (idx[2]) url += `&datef=${DATES[idx[2]][1]}`;
            if (idx[3]) url += `&durf=${DURS[idx[3]][1]}`;
            if (idx[4]) url += `&quality=${QUALS[idx[4]][1]}`;
            if (page > 1) url += `&p=${page - 1}`;
            const { list, hasNext } = this.parseList(await this.get(url));
            return { list, hasNextPage: list.length > 0 && hasNext };
        }
        if (rule) ruleApply("xv", rule, [idx[0]]);
        return this.listPage(idx[0], page);
    }

    async getDetail(url) {
        url = url.split("#")[0];
        const html = await this.get(url);
        const doc = new Document(html);
        const pick = (re) => (re.exec(html) || [])[1] || "";
        const og = first(doc, 'meta[property="og:title"]');
        let name = unesc(pick(/html5player\.setVideoTitle\('((?:[^'\\]|\\.)*)'/) || (og ? og.attr("content") : ""));
        const up = pick(/"uploadDate"\s*:\s*"([^"]+)"/);
        const ms = up ? Date.parse(up) || 0 : 0;
        const dur = isoDur(pick(/"duration"\s*:\s*"([^"]+)"/));
        const views = pick(/"userInteractionCount"\s*:\s*(\d+)/);
        // 큰 그림(setThumbUrl169)은 avif 라 앱에서 안 보일 수 있어 jpg(og:image) 먼저
        const ogImg = first(doc, 'meta[property="og:image"]');
        const img = (ogImg ? ogImg.attr("content") : "") || pick(/html5player\.setThumbUrl169\('([^']+)'/).replace(/\.avif$/, ".jpg");
        const tags = doc.select("a.is-keyword").map((a) => a.text.trim()).filter((t) => t);
        const names = doc.select(".video-metadata .name, .uploader-tag .name, .video-tags-list a.label .name")
            .map((x) => x.text.trim()).filter((t) => t);
        const author = names.length ? names[0] : "";
        const hd = /setVideoHLS\(/.test(html) && /1080p/.test(html) ? "최대 1080p" : "";
        const info = [dur ? `길이 ${dur}` : "", hd, views ? `조회 ${count(views)}` : "", ms ? `올린 날 ${ymd(ms)}` : ""]
            .filter((x) => x).join(" · ");
        const people = names.length > 1 ? `\n출연: ${Array.from(new Set(names.slice(1))).join(", ")}` : "";
        return {
            name: ms && name && !/\(\d{4}\)$/.test(name) ? `${name} (${ymd(ms).substring(0, 4)})` : name,
            imageUrl: img,
            author,
            genre: Array.from(new Set(tags)),
            status: 1,
            description: `${info}${people}`.trim(),
            link: url,
            episodes: [{ name: ms ? `1. 본편 (${ymd(ms)})` : "1. 본편", url, dateUpload: String(ms || Date.now()) }],
        };
    }

    // ================= 재생 =================
    async getVideoList(url) {
        url = url.split("#")[0];
        const html = await this.get(url);
        const headers = { "Referer": `${this.getBaseUrl()}/` };
        const pick = (re) => unesc((re.exec(html) || [])[1] || "");
        const hls = pick(/html5player\.setVideoHLS\('([^']+)'/);
        const high = pick(/html5player\.setVideoUrlHigh\('([^']+)'/);
        const low = pick(/html5player\.setVideoUrlLow\('([^']+)'/);
        const out = [];
        let why = "";
        if (hls) {
            const l = await hlsExpand(this.client, hls, LABEL, headers);
            if (l.length) out.push(...l);
            else why = "HLS 목록 열리지 않음";
        }
        if (high) out.push({ url: high, originalUrl: high, quality: `${LABEL} mp4 고화질`, headers });
        if (low && low !== high) out.push({ url: low, originalUrl: low, quality: `${LABEL} mp4 저화질`, headers });
        if (!out.length) {
            const shape = url.replace(/^https?:\/\//, "").substring(0, 48);
            throw new Error(`영상 주소를 못 찾았어요 [재생 · ${why || "화면에 영상 주소 없음"} · ${shape}]`);
        }
        return qualitySort("xv_quality", out);
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        return [
            { type_name: "HeaderFilter", name: `📝 시험판 ${mangayomiSources[0].version} · 휴대폰에서 목록·검색·재생 확인 중` },
            { type_name: "HeaderFilter", name: "검색어가 없으면 분류만 · 검색어가 있으면 검색 정렬·기간·길이·화질만 적용" },
            { type_name: "HeaderFilter", name: "검색창에 영상 주소를 붙여 넣으면 그 영상을 바로 열어요" },
        ].concat(FILTER_DEFS.map(([name, values]) => ({
            type_name: "SelectFilter", name, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v[0], value: String(j) })),
        })), ruleFilters("xv", RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText),
        // 하단 버튼에 가리지 않게 빈 줄 3개
        [1, 2, 3].map(() => ({ type_name: "HeaderFilter", name: "　" })));
    }

    getSourcePreferences() {
        return [{
            key: "xv_domain",
            editTextPreference: {
                title: "사이트 주소 직접 지정 (선택)",
                summary: "비워 두면 https://www.xvideos.com",
                value: "",
                dialogTitle: "사이트 주소",
                dialogMessage: "https:// 로 시작하는 주소",
            },
        }, {
            key: "xv_quality",
            listPreference: {
                title: "선호 화질",
                summary: "영상이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다.",
                valueIndex: 0,
                entries: QUALITY_CHOICES,
                entryValues: QUALITY_CHOICES,
            },
        }];
    }
}
