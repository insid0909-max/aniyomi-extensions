const mangayomiSources = [{
    "name": "티비톡",
    "lang": "ko",
    "baseUrl": "https://tvtok11.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.1",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/tvtok.js"
}];

// 2026-11-22 정식 0.1.0 (시험판 0.0.1~0.0.2 휴대폰 확인) — 미미티비가 새 사이트 "티비톡"(tvtok11.com)으로 바뀜(평생 주소 미미티비주소.com → tvtok11.com,
// 사이트 프로그램 안 저장 이름이 mimitv_* 그대로 = 같은 운영). 미미티비 확장과 달리 모두 JSON 자료이고 영상 주소를 바로 줌(웹뷰·암호 없음).
// 목록: /api/browse/{분류}?genre=&sort=(빈|popular|rating)&page=N&size=42 → {total, items[{id,type,title,thumb,year}]}
//   전체: /api/browse/top10 (첫 화면 /api/home 의 top10 은 10개뿐이지만 목록 주소로는 전체 25,093개·정렬 모두 됨, 0.0.2), 검색: /api/search?q= → {items}
// 작품: /api/watch/{분류}/{번호} → {title, thumb, genre, updated, episodes[{id,n,title,date,playable}](차례가 작품마다 다름 → 번호로 방향을 봐 최신이 위로), related}
// 영상: /api/playlist/{회차 id}/index.m3u8 (조각 res.tvwow1.com/….ts)
// 장르 거르기는 사이트 화면엔 있지만 자료(api)가 0개를 줘서(hasGenre false) 넣지 않음.
const DEFAULT_BASE_URL = "https://tvtok11.com";
const DOMAIN_RE = /^https:\/\/(?:www\.)?tvtok\d*\.[a-z]{2,6}$/;
const HOST_RE = /^https?:\/\/(?:www\.)?tvtok\d*\.[a-z]{2,6}(?=\/|$)/;
const GUIDE_URL = "https://t.me/s/tvtok_url";
// 평생 주소(미미티비주소.com) → 301 xlqlxhr.com → 301 tvtok11.com (2026-11-22 확인)
// 저장소 주소 목록 (사용자가 새 주소를 알려 주면 여기만 고치면 됨)
const DOMAIN_LIST_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/domains.json";
const LIFETIME_URL = "https://xn--hg3ba87o95e83l04o.com/";
let MOVED_CLIENT = null;

/** 넘겨 주는(301·302) 주소를 끝까지 따라가 마지막 주소의 origin (순정 망가요미: useDartHttpClient + followRedirects:false 면 location 을 그대로 줌) */
async function movedOrigin(url) {
    try {
        if (!MOVED_CLIENT) MOVED_CLIENT = new Client({ useDartHttpClient: true, followRedirects: false, timeout: 8, connectTimeout: 5 });
    } catch (e) {
        return null;
    }
    let cur = url;
    let moved = false;
    for (let i = 0; i < 6; i++) {
        let r;
        try {
            r = await MOVED_CLIENT.get(cur, { "User-Agent": UA });
        } catch (e) {
            break;
        }
        if (![301, 302, 303, 307, 308].includes(Number(r && r.statusCode))) break;
        const hs = (r && r.headers) || {};
        let loc = "";
        for (const k in hs) if (k.toLowerCase() === "location") loc = String(hs[k] || "").trim();
        if (!loc) break;
        const origin = (/^https?:\/\/[^/?#]+/i.exec(cur) || [""])[0];
        cur = /^https?:\/\//i.test(loc) ? loc : loc.startsWith("//") ? "https:" + loc : origin + (loc.startsWith("/") ? "" : "/") + loc;
        moved = true;
    }
    const m = moved ? /^https?:\/\/([^/?#]+)/i.exec(cur) : null;
    return m ? `https://${m[1].toLowerCase().replace(/^www\./, "")}` : null;
}
const LABEL = "티비톡";
const KEY = "tvtok";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const LISTS = [
    ["전체", "top10"], ["드라마", "drama"], ["해외드라마", "world"], ["추억드라마", "old_drama"],
    ["예능", "ent"], ["추억예능", "old_ent"], ["해외예능/다큐", "ott_ent"], ["시사/다큐", "sisa"],
    ["해외영화", "movie"], ["한국영화", "kor_movie"],
];
const TOP10 = 0;
const SORTS = [["최신순", ""], ["인기순", "popular"], ["평점순", "rating"]];
const PAGE_SIZE = 42;
const FILTER_DEFS = [
    ["분류", "type", LISTS.map((x) => x[0])],
    ["정렬", "sort", SORTS.map((x) => x[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [TOP10, 1];
const DEFAULT_LATEST = [TOP10, 0];
const MOVIE_TYPES = ["movie", "kor_movie"];

function ruleText(i) {
    return `${LISTS[i[0]][0]} · ${SORTS[i[1]][0]}`;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

/** "2026-09-23" → 한국 시각 0시의 밀리초 (없으면 0) */
function dayMs(s) {
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600000 : 0;
}

function fullDate(ms) {
    const d = new Date(ms + 9 * 3600000);
    return `${d.getUTCFullYear()}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())} (${"일월화수목금토"[d.getUTCDay()]})`;
}

// 응답에 글자 방식(charset)이 없으면 망가요미가 한글을 Latin-1 로 넘김 → 되돌림 (애니마루·삼성 TV 플러스와 같은 코드)
function fixUtf8(s) {
    s = String(s || "");
    if (/[^\u0000-\u00ff]/.test(s) || !/[\u0080-\u00ff]/.test(s)) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        let n = 0;
        let cp = 0;
        if (c >= 0xc2 && c <= 0xdf) { n = 1; cp = c & 0x1f; }
        else if (c >= 0xe0 && c <= 0xef) { n = 2; cp = c & 0x0f; }
        else if (c >= 0xf0 && c <= 0xf4) { n = 3; cp = c & 0x07; }
        let ok = n > 0 && i + n < s.length;
        for (let k = 1; ok && k <= n; k++) {
            const t = s.charCodeAt(i + k);
            if ((t & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (t & 0x3f);
        }
        if (ok) {
            out += String.fromCodePoint(cp);
            i += n;
        } else {
            out += s[i];
        }
    }
    return out;
}


let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 300 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

// selectFirst 는 비어도 값이 있는 것처럼 보이므로 select()[0] 사용
function first(el, css) {
    const l = el ? el.select(css) : [];
    return l && l.length ? l[0] : null;
}

function decodeHtml(s) {
    return String(s || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'");
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch (e) {
        return s;
    }
}


const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// HLS 마스터 목록에 화질이 여러 개면 각각 따로 고를 수 있게 나눔. 하나뿐이거나 읽지 못하면 그대로
// 주소에 "1080p" 같은 화질이 적혀 있으면 이름 뒤에 붙임 (mp4·단일 화질 영상도 지금 화질을 알 수 있게)
function withRes(label, url) {
    let path = String(url || "").split("?")[0];
    try {
        path = decodeURIComponent(path);
    } catch (e) {
        // 그대로 사용
    }
    const m = /(?:^|[^0-9])(2160|1440|1080|720|576|480|360|240)[pP](?![0-9a-zA-Z])/.exec(path);
    return m && !label.includes(`${m[1]}p`) ? `${label} ${m[1]}p` : label;
}

async function hlsExpand(client, url, label, headers) {
    const one = [{ url, originalUrl: url, quality: withRes(label, url), headers }];
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
    if (variants.length === 1) return [{ url, originalUrl: url, quality: `${label} ${variants[0].h}p`, headers }];
    if (variants.length < 2) return one;
    variants.sort((a, b) => b.h - a.h);
    return [{ url, originalUrl: url, quality: `${label} 자동 (최대 ${variants[0].h}p)`, headers }]
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
    const hit = (x) => x.quality.endsWith(` ${want}`) || x.quality.includes(` ${want} `);
    return list.filter(hit).concat(list.filter((x) => !hit(x)));
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


// ---------- 앱 기본 User-Agent 사용 ----------
// 망가요미는 내장 웹뷰에서 Cloudflare 확인을 통과하면 쿠키와 그 웹뷰의 User-Agent 를 함께 저장하고,
// 요청에 User-Agent 가 없을 때만 그 값을 넣는다. 확장이 고정 User-Agent 를 보내면 통과 쿠키가 거부되므로
// 사이트(문서·API) 요청에서는 확장의 User-Agent 를 빼고 앱 값을 쓰게 한다. 영상·이미지 주소 요청은 그대로 둔다.
// 망가요미 변형 앱(Mangayomi Glitch 등)은 User-Agent 를 넣어 주지 않아, 빼고 보내면 사이트가 연결을 끊거나 403 을 줌
// → 그런 응답이면 User-Agent 를 넣어 다시 보내고, 그 뒤로는 처음부터 넣음 (원래 망가요미는 첫 요청이 성공해 그대로)
let APP_NO_UA = false;
let APP_ALT = null;
// 주소를 못 찾는 오류(host lookup 실패)는 바로 할 일이 보이는 쉬운 말로 (2026-11-03)
function dnsFriendly(e, url) {
    const m = String((e && e.message) || e || "");
    if (!/host lookup|UnknownHost|No address associated|nodename nor servname|ERR_NAME_NOT_RESOLVED/i.test(m)) return e;
    const host = (/^https?:\/\/([^/?#]+)/.exec(String(url || "")) || [null, ""])[1];
    return new Error("사이트 주소를 찾지 못했어요. ① 잠시 뒤 다시 ② 앱을 완전히 껐다 켜기 ③ 유니콘 등 DNS 앱을 쓰면 DNS 를 Google 로 ④ 주소가 바뀌었으면 검색창에 새 주소 붙여 넣기" + (host ? ` [${host}]` : ""));
}

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
    // 망가요미 기본 통신이 끊기면 연결을 재사용하지 않는 별도 통신으로 한 번 더 (애니24에서 효과 확인, DC 확장과 같은 방법)
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
            res = null;
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
        get: (url, headers) => send((c, u, h) => c.get(u, h), url, headers).catch((e) => { throw dnsFriendly(e, url); }),
        post: (url, headers, body) => send((c, u, h) => c.post(u, h, body), url, headers).catch((e) => { throw dnsFriendly(e, url); }),
    };
}

// 망가요미 재생기는 재생용 주소(originalUrl) 모양으로 HLS 를 알아봄 → 확장자가 .m3u8 이 아닌 HLS 주소(.txt·jmp2 등)는
// 끝에 "#download.m3u8" 를 붙여 알려 줌. # 뒤는 서버로 보내지지 않아 실제 요청은 그대로 (애니24에서 효과 확인)
function hlsHint(list) {
    for (const v of list || []) {
        if (!v || !v.url) continue;
        const plain = String(v.url).replace(/#.*$/, "");
        const path = plain.split("?")[0];
        // 확장자 없는 주소 중 HLS 로 보이는 것만 (mp4 등 다른 영상에 붙이면 재생이 안 됨)
        const hlsLike = /\.txt$|\/hls\/|\/m3\/|master|playlist|jmp2\.uk\/stvp-/i.test(path);
        if (/^https?:\/\//.test(plain) && hlsLike && !/\.(?:m3u8?|mp4|mkv|webm|mov|m4v|ts|flv|avi|mp3|aac)$/i.test(path)) v.originalUrl = plain + "#download.m3u8";
    }
    return list;
}


/**
 * 회차 이름 읽기 (0.1.1, 작품 288개 회차 모양 점검): "제01회" → 1회, "이혼숙려캠프 제102회" → 102회(앞의 프로그램 이름 뺌),
 * "제05회 260923" → 5회 + 날짜 26.09.23, "제01회~제04회" → 1~4회, "제23회~최종회" → 23회~최종회, "제8화(완)" → 8화 (완)
 */
function epParse(label) {
    const s = String(label || "").trim();
    const fmt = (n) => String(Number(n));
    let m = /^(.*?)(?:제\s*)?(\d+(?:\.\d+)?)\s*(회|화)?\s*[~\-]\s*(?:제\s*)?(\d+(?:\.\d+)?|최종)\s*(회|화)(.*)$/.exec(s);
    let num = null;
    let head = "";
    let rest = "";
    if (m) {
        num = Number(m[2]);
        const unit = m[5];
        head = `${fmt(m[2])}${m[3] ? m[3] : ""}~${m[4] === "최종" ? "최종" : fmt(m[4])}${unit}`;
        rest = m[6];
    } else if ((m = /^(.*?)(?:제\s*)?(\d+(?:\.\d+)?)\s*(회|화)(.*)$/.exec(s))) {
        num = Number(m[2]);
        head = `${fmt(m[2])}${m[3]}`;
        rest = m[4];
    } else {
        return { num: null, name: s, ms: 0 };
    }
    rest = rest.trim();
    // 번호 뒤 6자리 날짜(yymmdd)는 날짜로
    let ms = 0;
    const dm = /^(\d{2})(\d{2})(\d{2})(?!\d)\s*/.exec(rest);
    if (dm && +dm[2] >= 1 && +dm[2] <= 12 && +dm[3] >= 1 && +dm[3] <= 31) {
        ms = Date.UTC(2000 + +dm[1], +dm[2] - 1, +dm[3]) - 9 * 3600000;
        rest = rest.substring(dm[0].length).trim();
    }
    return { num, name: head + (rest ? " " + rest : ""), ms };
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    // ================= 주소 =================
    // 직접 넣은 주소(설정) > 찾은 주소(tvtok_auto_domain, 확인 후 저장) > 기본 주소
    getBaseUrl() {
        let custom = "";
        let auto = "";
        try {
            const p = new SharedPreferences();
            custom = String(p.get("tvtok_domain") || "").trim().replace(/\/+$/, "");
            auto = String(p.getString("tvtok_auto_domain", "") || "").trim();
        } catch (e) {
            custom = "";
        }
        if (custom && !/^https?:\/\//.test(custom)) custom = "https://" + custom;
        if (DOMAIN_RE.test(custom)) return custom;
        return DOMAIN_RE.test(auto) ? auto : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    /** 진짜 티비톡이면 true (첫 화면 자료 /api/home 이 top10 을 줌) */
    async isSite(origin) {
        try {
            const r = await this.client.get(`${origin}/api/home`, { "User-Agent": UA, "Accept": "application/json" });
            return Number(r.statusCode) === 200 && /"top10"\s*:/.test(String(r.body || ""));
        } catch (e) {
            return false;
        }
    }

    /** 주소가 끊겼을 때: 저장소 주소 목록 → 안내 채널(t.me/s/tvtok_url)의 큰 번호 3개 → 평생 주소·지금 주소가 넘겨 주는 곳 → 번호 +1~+3 (1분에 한 번) */
    async discover() {
        const p = new SharedPreferences();
        if (Date.now() - (Number(p.getString("tvtok_discover_at", "0")) || 0) < 60000) return null;
        p.setString("tvtok_discover_at", String(Date.now()));
        const cur = this.getBaseUrl();
        const num = (u) => Number((/tvtok(\d+)/.exec(u) || [0, 0])[1]);
        const tries = [];
        try {
            const r = await this.client.get(DOMAIN_LIST_URL + "?t=" + Math.floor(Date.now() / 60000), { "Cache-Control": "no-cache" });
            const u = String((((JSON.parse(String(r.body || "{}")).domains || {})[KEY]) || {}).baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
            if (DOMAIN_RE.test(u)) tries.push(u);
        } catch (e) {
            // 다음 방법으로
        }
        try {
            const r = await this.client.get(GUIDE_URL, { "User-Agent": UA });
            const found = [...new Set((String(r.body || "").match(/tvtok\d+\.com/gi) || []).map((h) => "https://" + h.toLowerCase()))];
            found.sort((a, b) => num(b) - num(a)).slice(0, 3).forEach((u) => tries.push(u));
        } catch (e) {
            // 다음 방법으로
        }
        const moved = await Promise.all([movedOrigin(LIFETIME_URL), movedOrigin(cur + "/")]);
        moved.forEach((u) => u && DOMAIN_RE.test(u) && tries.push(u));
        for (let i = 1; i <= 3; i++) tries.push(`https://tvtok${num(cur) + i}.com`);
        for (const u of [...new Set(tries)]) {
            if (u === cur || num(u) < num(cur)) continue;
            if (await this.isSite(u)) {
                p.setString("tvtok_auto_domain", u);
                return u;
            }
        }
        return null;
    }

    async api(path) {
        const call = async (base) => {
            let res = null;
            for (let attempt = 0; attempt < 2 && !res; attempt++) {
                await siteWait();
                try {
                    res = await this.client.get(base + path, Object.assign(this.getHeaders(), { "Accept": "application/json" }));
                } catch (e) {
                    if (attempt === 1) throw e;
                    await new Promise((r) => setTimeout(r, 700));
                }
            }
            return res;
        };
        const base = this.getBaseUrl();
        let res = null;
        let err = null;
        try {
            res = await call(base);
        } catch (e) {
            err = e;
        }
        // 연결 실패·5xx·451 일 때만 새 주소 찾기 (403 보안 확인은 주소 바뀜 아님)
        const code = res ? Number(res.statusCode) : 0;
        if (!res || code >= 500 || code === 451) {
            const found = await this.discover();
            if (found) res = await call(found);
        }
        if (!res) throw new Error(`티비톡 접속 실패: ${String((err && err.message) || err).substring(0, 80)}`);
        let data = null;
        try {
            data = JSON.parse(fixUtf8(res.body));
        } catch (e) {
            data = null;
        }
        if (Number(res.statusCode) >= 400 || !data) {
            const head = String(res.body || "").replace(/\s+/g, " ").substring(0, 60);
            throw new Error(`티비톡 자료를 받지 못했어요 [${path.split("?")[0]} · HTTP ${res.statusCode} · ${head}]`);
        }
        return data;
    }

    /** "/watch/drama/4965" 모양만 (주소 붙여 넣기·서재) */
    pathOf(href) {
        let p = String(href || "").trim();
        if (/^https?:\/\//.test(p)) {
            if (!HOST_RE.test(p)) return null;
            p = p.replace(HOST_RE, "");
        }
        const m = /^\/watch\/([a-z_]+)\/(\d+)/.exec(p.split("#")[0]);
        return m ? `/watch/${m[1]}/${m[2]}` : null;
    }

    card(it) {
        return { name: String(it.title || "").trim(), imageUrl: String(it.thumb || ""), link: `/watch/${it.type}/${it.id}` };
    }

    // ================= 목록 =================
    async listPage(idx, page) {
        const q = `genre=&sort=${SORTS[idx[1]][1]}&page=${page}&size=${PAGE_SIZE}`;
        const d = await this.api(`/api/browse/${LISTS[idx[0]][1]}?${q}`);
        const list = (d.items || []).map((x) => this.card(x)).filter((x) => x.name);
        return { list, hasNextPage: list.length > 0 && page * PAGE_SIZE < (Number(d.total) || 0) };
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return this.listPage(ruleRead(KEY, true, RULE_SIZES) || DEFAULT_POPULAR, page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead(KEY, false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 사이트 주소를 붙여 넣으면 확인 후 그 주소를 씀, 작품 주소면 그 작품을 바로 열기
        const host = /^(?:https?:\/\/)?((?:www\.)?tvtok\d*\.[a-z]{2,6})(\/\S*)?$/i.exec(query);
        if (host) {
            const origin = "https://" + host[1].toLowerCase().replace(/^www\./, "");
            if (origin !== this.getBaseUrl()) {
                if (!(await this.isSite(origin))) throw new Error(`티비톡 화면을 확인하지 못했어요 [${host[1]}]`);
                new SharedPreferences().setString("tvtok_auto_domain", origin);
            }
            const path = this.pathOf(host[2] || "");
            if (!path) return this.getPopular(page);
            if (page > 1) return { list: [], hasNextPage: false };
            const d = await this.getDetail(path);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: path }], hasNextPage: false };
        }
        if (query) {
            if (page > 1) return { list: [], hasNextPage: false };
            const d = await this.api(`/api/search?q=${encodeURIComponent(query)}`);
            return { list: (d.items || []).map((x) => this.card(x)).filter((x) => x.name), hasNextPage: false };
        }
        const idx = [0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), RULE_SIZES[k] - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (rule) ruleApply(KEY, rule, idx);
        return this.listPage(idx, page);
    }

    // ================= 작품 정보 · 회차 =================
    async getDetail(url) {
        const path = this.pathOf(url) || url;
        const m = /^\/watch\/([a-z_]+)\/(\d+)$/.exec(path);
        if (!m) throw new Error(`잘못된 작품 주소예요: ${url}`);
        const d = await this.api(`/api/watch/${m[1]}/${m[2]}`);
        const title = String(d.title || "").trim();
        const movie = MOVIE_TYPES.includes(m[1]);
        const bare = (s) => String(s || "").replace(title, "").replace(/^[\s:·\-–]+/, "").trim();
        const episodes = [];
        let newest = 0;
        // 회차 차례가 작품마다 다름(신병4 는 최신이 위, 옛 드라마는 1화가 위, 메이드 인 코리아 2 는 6·4·3·2·1·05 로 섞임)
        // → 모두 번호가 있으면 번호 큰 순서로, 번호 없는 회차가 섞이면 방향만 맞춤 (0.1.1)
        const raw = (d.episodes || []).filter((e) => e && e.id != null)
            .map((e, i) => ({ e, i, p: epParse(bare(e.title) || String(e.title || "").trim()) }));
        const numbered = raw.filter((x) => x.p.num != null);
        if (numbered.length === raw.length && raw.length >= 2) raw.sort((a, b) => b.p.num - a.p.num || a.i - b.i);
        else if (numbered.length >= 2 && numbered[0].p.num < numbered[numbered.length - 1].p.num) raw.reverse();
        for (const { e, p } of raw) {
            const ms = dayMs(e.date) || p.ms;
            if (ms > newest) newest = ms;
            const date = ms ? ` (${pad2(new Date(ms + 9 * 3600000).getUTCMonth() + 1)}.${pad2(new Date(ms + 9 * 3600000).getUTCDate())})` : "";
            episodes.push({ name: p.name + date, url: `${path}#ep=${e.id}`, dateUpload: ms ? String(ms) : null });
        }
        if (movie && episodes.length === 1) episodes[0].name = "1. 본편";
        const updated = dayMs(d.updated) || newest;
        const ongoing = !movie && updated && Date.now() - updated < 21 * 86400000;
        const shortDate = updated ? `${pad2(new Date(updated + 9 * 3600000).getUTCMonth() + 1)}.${pad2(new Date(updated + 9 * 3600000).getUTCDate())}` : "";
        const year = Number(d.year) || (updated ? new Date(updated + 9 * 3600000).getUTCFullYear() : 0);
        let name = title;
        if (ongoing && shortDate) name = `${title} · ${shortDate}`;
        else if (!movie && year && !/\((?:19|20)\d{2}\)/.test(title)) name = `${title} (${year})`;
        const genre = String(d.genre || "").split("/").map((x) => x.trim()).filter((x) => x);
        return {
            name,
            imageUrl: String(d.thumb || ""),
            link: this.getBaseUrl() + path,
            description: [
                ongoing && updated ? `방영 중 · 최근 방영: ${fullDate(updated)}` : "",
                String(d.synopsis || "").trim(),
                `분류: ${(LISTS.find((x) => x[1] === m[1]) || [m[1]])[0]}`,
            ].filter((x) => x).join("\n\n"),
            author: "",
            // 날짜 정보가 하나도 없는 드라마는 상태를 알 수 없음(5)
            status: movie ? 1 : ongoing ? 0 : updated ? 1 : 5,
            genre,
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        const ep = (/#ep=(\d+)/.exec(String(url || "")) || [])[1];
        if (!ep) throw new Error("회차 정보가 없어요. 회차 목록을 새로고침해 주세요.");
        const base = this.getBaseUrl();
        const main = `${base}/api/playlist/${ep}/index.m3u8`;
        const h = { "User-Agent": UA, "Referer": `${base}/`, "Origin": base };
        const list = await hlsExpand(this.client, main, LABEL, h);
        if (!list.length) throw new Error(`영상 주소를 열지 못했어요 [회차 ${ep}]`);
        return qualitySort("tvtok_quality", list.map((v) => Object.assign(v, { subtitles: [], audios: [] })));
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${host}` },
            { type_name: "HeaderFilter", name: "🔗 미미티비가 이름을 바꾼 새 사이트 (같은 운영)" },
            ...notesFilters(KEY),
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (사이트·작품 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })),
        ruleFilters(KEY, RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: "tvtok_domain",
            editTextPreference: {
                title: "티비톡 주소 직접 지정 (선택)",
                summary: `비워 두면 기본 주소(${DEFAULT_BASE_URL})·찾은 주소를 사용합니다.`,
                value: "",
                dialogTitle: "티비톡 주소",
                dialogMessage: "https:// 로 시작하는 티비톡 주소 (예: https://tvtok11.com)",
            },
        }, qualityPreference("tvtok_quality")];
    }
}

// ---------- 업데이트 내역 (필터 맨 위 📝 줄) ----------
// 저장소의 changelog.json 을 1시간에 한 번 받아 두었다가 그 소스의 최근 3개를 보여 줌 (필터 화면을 열 때 기다리지 않음)
const NOTES_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/changelog.json";

async function notesRefresh(client) {
    let p;
    try {
        p = new SharedPreferences();
    } catch (e) {
        return;
    }
    await verRefresh(client, p);
    const last = Number(p.getString("notes_at", "0")) || 0;
    if (Date.now() - last < 60 * 60000) return;
    p.setString("notes_at", String(Date.now()));
    try {
        const r = await client.get(NOTES_URL, {});
        const body = String(r.body || "");
        if (r.statusCode === 200 && body.trim().startsWith("{")) p.setString("notes_json", body);
    } catch (e) {
        // 다음 기회에 다시 받음
    }
}

// ---------- 설치 버전 확인 (필터 맨 위 📝 줄) ----------
// 망가요미는 자동 업데이트를 해도 알림이 없어 → 설치된 버전과 저장소의 최신 버전을 1시간마다 비교해 보여 줌 (2026-11-03)
const VER_INDEX_URLS = ["https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/mangayomi/anime_index.json"];

function verCmp(a, b) {
    const x = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
    const y = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
}

async function verRefresh(client, p) {
    const last = Number(p.getString("ver_at", "0")) || 0;
    if (Date.now() - last < 60 * 60000) return;
    p.setString("ver_at", String(Date.now()));
    const file = String(mangayomiSources[0].pkgPath || "").split("/").pop();
    for (const u of VER_INDEX_URLS) {
        try {
            const r = await client.get(u, {});
            const arr = JSON.parse(String(r.body || "[]"));
            const hit = (Array.isArray(arr) ? arr : []).find((x) => x && String(x.sourceCodeUrl || "").endsWith("/" + file));
            if (hit && hit.version) {
                p.setString("ver_latest", String(hit.version));
                return;
            }
        } catch (e) {
            // 다음 기회에 다시 확인
        }
    }
}

function verLine(key, note) {
    // 버전과 마지막 업데이트 내역을 한 줄로 (필터가 지저분해 보여, 사용자 2026-11-03)
    const mine = String(mangayomiSources[0].version || "");
    let latest = "";
    try {
        latest = new SharedPreferences().getString("ver_latest", "") || "";
    } catch (e) {
        latest = "";
    }
    const last = note && note.t ? ` · ${String(note.d || "").substring(5).replace("-", ".")} ${String(note.t).replace(/^망가요미:\s*/, "")}` : "";
    let name = `📝 ${mine}${last}`;
    if (latest && verCmp(latest, mine) > 0) name = `📝 ⚠️ OLD ${mine} → 새 버전 ${latest} 있음, 확장 화면에서 업데이트`;
    else if (latest) name = `📝 🆕 NEW ${mine}${last}`;
    return { type_name: "HeaderFilter", name, _status: true };
}

function notesFilters(key) {
    let list = [];
    try {
        list = (JSON.parse(new SharedPreferences().getString("notes_json", "") || "{}").items || {})[key] || [];
    } catch (e) {
        list = [];
    }
    return [verLine(key, list.filter((n) => n && n.t)[0])];
}

// ---------- 필터 맨 끝 빈 줄 (2026-11-03) ----------
// 망가요미 필터 창이 휴대폰 하단 버튼(|||·○·<)에 가려 맨 아래 항목이 안 눌림 → 맨 끝에 빈 줄을 두어 위로 올릴 수 있게.
// 맨 끝에만 붙여 기존 필터 순서·저장된 탭 규칙은 그대로
(function () {
    const base = DefaultExtension.prototype.getFilterList;
    DefaultExtension.prototype.getFilterList = function () {
        const list = base.apply(this, arguments) || [];
        return list.concat([1, 2, 3].map(() => ({ type_name: "HeaderFilter", name: "\u3000", _status: true })));
    };
})();

// ---------- 검색 띄어쓰기 (2026-11-05) ----------
// 사이트 검색이 띄어쓰기를 구분해 "괴력난신"·"나혼자만레벨업" 으로는 "괴력 난신"·"나 혼자만 레벨업" 이 안 나오는 곳이 있음.
// 결과가 0개일 때만: ① 띄어쓰기를 뺀 검색어 ② 검색어 앞부분(절반) ③ 두 글자씩(앞에서부터) 으로 최대 6번 다시 찾아,
// 띄어쓰기·기호를 빼고 비교했을 때 검색어가 들어 있는 작품만 보여 줌. 결과가 있으면 원래 그대로
(function () {
    const base = DefaultExtension.prototype.search;
    DefaultExtension.prototype.search = async function (query, page, filters) {
        const r = await base.apply(this, arguments);
        const q = String(query || "").trim();
        if (!q || Number(page) > 1 || /^(?:https?:\/\/|[\w-]+(?:\.[\w-]+)+(?:[/?#]|$))/i.test(q) || (r && r.list && r.list.length)) return r;
        const squash = (s) => String(s || "").normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
        const want = squash(q);
        if (want.length < 2) return r;
        const joined = q.replace(/\s+/g, "");
        const tries = [];
        const add = (t) => { if (t && t.length >= 2 && t !== q && tries.indexOf(t) < 0) tries.push(t); };
        // 사이트 검색은 쉼표·쌍점·물결·괄호·한자 같은 기호가 있으면 못 찾음("밑도 끝도 없이, 너다" 0개, 2026-11-06 검색 검사)
        // → 기호를 뺀 검색어, 앞쪽 단어만으로 먼저 찾아 봄
        const plain = q.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/[\u3400-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
        const words = plain.split(" ").filter((w) => w);
        add(plain);
        if (words.length > 2) add(words.slice(0, words.length - 1).join(" "));
        if (words.length > 1) add(words.slice(0, Math.ceil(words.length / 2)).join(" "));
        add(joined);
        if (joined.length > 2) add(joined.substring(0, Math.max(2, Math.ceil(joined.length / 2))));
        for (let i = 0; i + 2 <= joined.length; i++) add(joined.substring(i, i + 2));
        for (const t of tries.slice(0, 8)) {
            try {
                const r2 = await base.call(this, t, 1, filters);
                const hit = ((r2 && r2.list) || []).filter((x) => squash(x && x.name).includes(want));
                if (hit.length) return { list: hit, hasNextPage: false };
            } catch (e) {
                // 다음 방법으로
            }
        }
        return r;
    };
})();

// ---------- 영화 회차 이름 통일 (2026-11-06, 사용자 "통일시켜") ----------
// 확장마다 영화 회차가 "바로보기"·"한글자막"·"1회 · 바로보기"·"애니감상"·"1. 극장판 X" 처럼 달라서 → "본편" 으로.
// 회차가 하나뿐이고 회차 번호(N화·N회·EN)가 없을 때만 (자막·더빙 같은 구분은 괄호로), 상태를 모르면 완결
(function () {
    const base = DefaultExtension.prototype.getDetail;
    const core = (n) => String(n || "").replace(/^\s*\d+\s*(?:회)?\s*[.·]\s*/, "").replace(/\s*\(\d{2}\.\d{2}\)\s*$/, "").trim();
    const hasNo = (n) => /\d+\s*(?:화|회)|(?:^|\s)E\d+/i.test(core(n));
    const movieName = (n) => {
        const v = (core(n).match(/한글\s*자막|영어\s*자막|자막|더빙|무삭제|감독판|확장판|극장판/g) || [])
            .map((x) => x.replace(/\s+/g, "")).filter((x) => x !== "극장판");
        return v.length ? `본편 (${[...new Set(v)].join(" · ")})` : "본편";
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const eps = (d && d.episodes) || [];
        const variant = /바로\s*보기|본편|자막|더빙|애니감상/;
        const movie = eps.length === 1 ? !hasNo(eps[0].name)
            : eps.length > 1 && eps.every((e) => !hasNo(e.name) && variant.test(core(e.name)));
        if (!movie) return d;
        // 망가요미는 이름 맨 앞 숫자로 회차 번호를 매김 → 숫자가 없으면 "번호를 매길 수 없음" 경고가 떠서 "1. 본편" (사용자, 2026-11-06)
        eps.forEach((e, i) => { e.name = `${i + 1}. ${movieName(e.name)}`; });
        if (d.status === 5 || d.status === undefined) d.status = 1;
        return d;
    };
})();

// ---------- 회차 번호 겹침 막기 (2026-11-07 회차 점검) ----------
// 망가요미는 회차 이름에서 숫자를 읽어 번호를 매기고(lib/utils/chapter_recognition.dart: 작품 제목을 지운 뒤 첫 숫자,
// "season/s/t N"·"ep N" 따로), 번호가 같은 회차는 하나만 남김 → "프롤로그 · 남은 98화"(98)와 "98화"가 겹치거나
// "키스 대신 7초 34화"가 모두 7 이 되어 회차가 사라짐. 같은 방식으로 미리 읽어 보고, 겹치거나 번호가 없는 작품만
// 오래된 회차부터 겹치지 않는 번호를 이름 앞에 붙임("35. …", 겹치면 "39.01. …"). 문제없는 작품은 그대로
(function () {
    const base = DefaultExtension.prototype.getDetail;
    const unwanted = /\b(?:v|ver|vol|version|volume|season|staffel|saison|temporada|s|t)[^a-z]?[0-9]+/g;
    const seasonKw = /\b(?:staffel|season|saison|temporada|s|t)\s*([0-9]+)/;
    const epKw = /\b(?:folge|episode|episodio|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/;
    const chNot = /(?<=ch\.) *([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
    const bare = /([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
    const dec = (d, a) => {
        if (d) return parseFloat(d);
        if (a) {
            if (a.includes("extra")) return 0.99;
            if (a.includes("omake")) return 0.98;
            if (a.includes("special")) return 0.97;
            const t = a.replace(".", "");
            if (t.length === 1) { const k = t.charCodeAt(0) - 96; return k >= 10 ? 0 : k / 10; }
        }
        return 0;
    };
    const read = (title, ch) => {
        let n = String(ch || "").toLowerCase();
        if (title) n = n.split(String(title).toLowerCase()).join("");
        n = n.trim().replace(/,/g, ".").replace(/-/g, ".").replace(/\s(?=extra|special|omake)/g, "");
        const sm = seasonKw.exec(n);
        const season = sm ? sm[1] : "0";
        const em = epKw.exec(n);
        if (em) return { season, ep: parseFloat(em[1]) };
        const s2 = n.replace(unwanted, "");
        const m = chNot.exec(s2) || bare.exec(s2);
        return { season, ep: m ? parseFloat(m[1]) + dec(m[2], m[3]) : null };
    };
    const ok = (list, title) => {
        const seen = {};
        for (const x of list) {
            const r = read(title, x.name);
            if (r.ep === null || !(r.ep > 0)) return false;
            const k = `${r.season}::${r.ep}::${x.scanlator || ""}`;
            if (seen[k]) return false;
            seen[k] = true;
        }
        return true;
    };
    // 붙일 번호 짐작: "34화"·"5회" 를 먼저, 없으면 앱 방식. 확장이 붙인 " · 남은 N화"·" · 마지막"·끝 날짜 "(11.05)" 는 빼고 읽음
    const guessNo = (title, name) => {
        const core = String(name || "").replace(/\s*·\s*(?:남은\s*\d+\s*화|마지막)\s*$/, "").replace(/\s*\(\d{2}(?:\.\d{2}){1,2}\)\s*$/, "");
        const m = /(\d+(?:[.-]\d+)?)\s*(?:화|회|話)/.exec(core);
        if (m) return parseFloat(m[1].replace("-", "."));
        return read(title, core).ep;
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const list = d && (d.episodes || d.chapters);
        if (!list || !list.length) return d;
        const title = String(d.name || "");
        // 앱이 기억한 제목이 조금 달라 지워지지 않는 경우까지 보려고 제목을 지운 것·안 지운 것 둘 다 확인
        if (ok(list, title) && ok(list, "")) return d;
        let last = 0;
        const fmt = (v) => String(Math.round(v * 100) / 100);
        for (let i = list.length - 1; i >= 0; i--) { // 목록은 최신이 위 → 오래된 것부터
            const x = list[i];
            const plain = String(x.name || "").replace(/^\s*\d+(?:\.\d+)?\.\s+/, "");
            const guess = guessNo(title, plain);
            const v = guess !== null && guess > last ? guess : Math.round((last + 0.01) * 100) / 100;
            last = v;
            const lead = /^\s*(\d+(?:\.\d+)?)/.exec(plain);
            x.name = lead && parseFloat(lead[1]) === v && !/^\s*\d+(?:\.\d+)?\s*[-.,]\s*\d/.test(plain) ? plain : `${fmt(v)}. ${plain}`;
        }
        return d;
    };
})();
