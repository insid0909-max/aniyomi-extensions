const mangayomiSources = [{
    "name": "[시험] 애니야24",
    "lang": "ko",
    "baseUrl": "https://www.aniya24.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": true,
    "hasCloudflare": true,
    "version": "0.0.3",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/aniya24.js"
}];

// 애니야24(www.aniya24.com, 2026-11-09, 시험판). 해외에서는 사이트 전체가 Cloudflare 보안 확인(403)이라
// 사용자가 보내 준 화면 소스(첫 화면·작품 화면)로 구조를 보고 만듦. 워드프레스(vidmov 테마).
// 목록: /series/ (전체), /series-category/{분류}/ , 쪽은 /page/N/, 정렬은 ?orderby=modified|date|title (워드프레스 기본 값, 휴대폰 확인 전)
//   카드 #main-content article.post-item → a.post-listing-title(제목·주소) + img.blog-img
// 검색: /?s=검색어&post_type=vidmov_series
// 작품: /series/{이름}/ — 제목 h1.entry-title, 회차 .main-series-items .series-item a (주소 …/group-query-id/G/media-query-id/ID/page/1/),
//   TMDB 칸(Release Date·Status·원제·장르), 회차 날짜 없음(작품 수정 시각 article:modified_time 만)
// 재생: 회차 화면의 beeteam368_pro_player({...}) 설정 video_url = iframe.mediadelivery.net/embed/{번호}/{영상ID} (Bunny Stream)
//   → 영상은 {vz-….b-cdn.net}/{영상ID}/playlist.m3u8, Referer 가 있어야 열림(없으면 403), 표준 AES-128(열쇠 주소가 목록에 있음)
//   해외에서도 열려 재생 목록·열쇠 확인함. 설정의 광고 영상(video_ads_params)은 쓰지 않음
const DEFAULT_BASE_URL = "https://www.aniya24.com";
const DOMAIN_RE = /^https:\/\/(?:www\.)?aniya24\d*\.[a-z]{2,6}$/;
const HOST_RE = /^https?:\/\/(?:www\.)?aniya24\d*\.[a-z]{2,6}(?=\/|$)/;
const LABEL = "애니야24";
const KEY = "aniya24";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const PLAYER_ORIGIN = "https://iframe.mediadelivery.net";

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함). 분류 이름은 사이트 그대로, 값은 사이트 주소의 분류 이름
const KINDS = [
    ["전체", ""], ["극장판", "극장판"], ["TV 애니", "tv-shows"], ["일반", "일반"], ["19+", "19"], ["청불", "청불"],
    ["동인지", "동인지"], ["OAD", "oad"], ["액션", "액션"], ["판타지", "판타지"], ["학원", "학원"], ["로멘스", "로멘스"],
    ["SF", "sf"], ["공포", "공포"], ["미스테리", "미스테리"], ["범죄 스릴러", "범죄-스릴러"], ["추리", "추리"],
    ["스포츠", "스포츠"], ["코미디", "코미디"], ["전쟁", "전쟁"],
];
const SORTS = [["최근 업데이트", "orderby=modified&order=DESC"], ["새로 올라온 순", "orderby=date&order=DESC"], ["제목순", "orderby=title&order=ASC"]];
const FILTER_DEFS = [
    ["분류", "kind", KINDS.map((k) => k[0])],
    ["정렬", "sort", SORTS.map((d) => d[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [2, 0];
const DEFAULT_LATEST = [0, 0];

function ruleText(i) {
    return `${KINDS[i[0]][0]} · ${SORTS[i[1]][0]}`;
}

let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 300 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

// "{...}" 를 중괄호 수를 세어 꺼냄 (글자 안의 중괄호는 무시)
function braceBlock(s, start) {
    let depth = 0;
    let str = null;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (str) {
            if (c === "\\") i++;
            else if (c === str) str = null;
            continue;
        }
        if (c === "\"" || c === "'") str = c;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return s.substring(start, i + 1);
    }
    return "";
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

function dayMs(s) {
    const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600000 : 0;
}

function mmdd(ms) {
    const d = new Date(ms + 9 * 3600000).toISOString();
    return d.substring(5, 7) + "." + d.substring(8, 10);
}

function fullDate(ms) {
    const d = new Date(ms + 9 * 3600000);
    const w = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
    return d.toISOString().substring(0, 10).replace(/-/g, ".") + ` (${w})`;
}

// 압축된 자바스크립트(eval(function(p,a,c,k,e,d)…)를 원래 글로 풀기 (흔한 공개 압축 방식)
function unpack(src) {
    try {
        const m = /\}\('([\s\S]*)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/.exec(src);
        if (!m) return "";
        let p = m[1].replace(/\\'/g, "'");
        const a = parseInt(m[2], 10);
        let c = parseInt(m[3], 10);
        const k = m[4].split("|");
        const enc = (n) => (n < a ? "" : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
        const dict = {};
        while (c--) dict[enc(c)] = k[c] || enc(c);
        return p.replace(/\b\w+\b/g, (w) => (w in dict ? dict[w] : w));
    } catch (e) {
        return "";
    }
}



// 이 헤더로 영상 주소가 실제로 열리는지 (m3u8 이면 내용까지 확인)
async function mediaWorks(client, url, headers) {
    // mp4 같은 영상 파일은 확인하려면 파일 전체를 받아야 해서(망가요미는 본문을 끝까지 받음) 확인하지 않음
    if (!url.includes(".m3u8")) return true;
    try {
        const res = await client.get(url, headers);
        if (Number(res.statusCode) >= 400) return false;
        return !url.includes(".m3u8") || String(res.body || "").trim().startsWith("#EXTM3U");
    } catch (e) {
        return false;
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

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    // ================= 주소 =================
    getBaseUrl() {
        let custom = "";
        try {
            custom = (new SharedPreferences().get("aniya24_domain") || "").trim().replace(/\/+$/, "");
        } catch (e) {
            custom = "";
        }
        if (custom && !/^https?:\/\//.test(custom)) custom = "https://" + custom;
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        if (/b-cdn\.net|mediadelivery\.net/.test(String(url || ""))) return { "User-Agent": UA, "Referer": `${PLAYER_ORIGIN}/` };
        // 사이트(표지 포함)는 User-Agent 를 넣지 않음 → 앱이 웹뷰 값을 넣어 보안 확인 통과 정보와 맞음
        return { "Referer": `${this.getBaseUrl()}/` };
    }

    /** missingOk: 404 면 빈 글(목록 끝) */
    async get(path, missingOk) {
        const base = this.getBaseUrl();
        const url = /^https?:\/\//.test(path) ? path : base + path;
        const h = this.getHeaders(url);
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            if (url.startsWith(base)) await siteWait();
            try {
                res = await this.client.get(url, h);
            } catch (e) {
                if (attempt === 1) throw new Error(`${LABEL} 접속 실패: ${String((e && e.message) || e).substring(0, 80)}`);
                await new Promise((r) => setTimeout(r, 700));
            }
        }
        const body = String(res.body || "");
        if (res.statusCode === 404 && missingOk) return "";
        if (res.statusCode === 403 && /Just a moment|cf-chl|challenge-platform/i.test(body)) {
            throw new Error(`${LABEL} 보안 확인이 필요해요. 오른쪽 위 웹뷰(지구본)로 사이트를 한 번 열었다가 돌아와 다시 시도해 주세요.`);
        }
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 (HTTP ${res.statusCode}). 주소가 바뀌었으면 설정에서 새 주소를 넣어 주세요.`);
        return body;
    }

    abs(u) {
        // 표지 파일 이름이 한글 그대로라 주소 글자로 바꿈 (이미 %XX 인 부분은 그대로)
        u = String(u || "").trim().replace(/[^\x00-\x7F]+/g, (x) => encodeURIComponent(x));
        if (!u || /^https?:\/\//.test(u)) return u;
        if (u.startsWith("//")) return "https:" + u;
        return this.getBaseUrl() + (u.startsWith("/") ? u : "/" + u);
    }

    /** 작품 주소 → "/series/이름/" (회차 주소여도 작품으로). 아니면 null */
    seriesPath(href) {
        let p = String(href || "").trim();
        if (/^https?:\/\//.test(p)) {
            if (!HOST_RE.test(p)) return null;
            p = p.replace(HOST_RE, "");
        }
        p = p.split("#")[0].split("?")[0];
        const m = /^\/series\/([^/]+)/.exec(p);
        if (!m) return null;
        let slug = m[1];
        try {
            slug = encodeURIComponent(decodeURIComponent(slug)).toLowerCase();
        } catch (e) {
            // 그대로
        }
        return `/series/${slug}/`;
    }

    /** 회차 주소 → 사이트 안 경로 ("/series/이름/group-query-id/0/media-query-id/123/page/1/") */
    episodePath(href) {
        let p = String(href || "").trim();
        if (/^https?:\/\//.test(p)) {
            if (!HOST_RE.test(p)) return null;
            p = p.replace(HOST_RE, "");
        }
        return p.split("#")[0].startsWith("/series/") ? p : null;
    }

    // ================= 목록 =================
    listPath(idx, page) {
        const slug = KINDS[idx[0]][1];
        let p = slug ? `/series-category/${encodeURIComponent(slug)}/` : "/series/";
        if (page > 1) p += `page/${page}/`;
        return `${p}?${SORTS[idx[1]][1]}`;
    }

    /** 목록 화면의 작품 카드 (옆 칸 "최신 업로드" 카드는 빼려고 본문(#main-content) 안만) */
    parseCards(html, page) {
        const doc = new Document(html);
        let cards = doc.select("#main-content article.post-item");
        if (!cards.length) cards = doc.select("article.post-item");
        const seen = {};
        const list = [];
        for (const card of cards) {
            const a = first(card, "a.post-listing-title") || first(card, "a[href]");
            if (!a) continue;
            const path = this.seriesPath(a.attr("href"));
            if (!path || seen[path]) continue;
            seen[path] = true;
            const title = decodeHtml(a.attr("title") || a.text || "").trim();
            const img = first(card, "img.blog-img") || first(card, "img");
            const src = img ? (img.attr("data-src") || img.attr("data-lazy-src") || img.attr("src")) : "";
            list.push({ name: title, imageUrl: this.abs(src), link: path });
        }
        // 쪽 번호 링크가 있거나, 쪽이 꽉 차 보이면 다음 쪽이 있다고 봄 (빈 쪽·404 면 끝)
        const next = list.length > 0 && (html.includes(`/page/${page + 1}/`) || list.length >= 8);
        return { list, hasNextPage: next };
    }

    async listPage(idx, page) {
        return this.parseCards(await this.get(this.listPath(idx, page), true), page);
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        const r = await this.listPage(ruleRead(KEY, true, RULE_SIZES) || DEFAULT_POPULAR, page);
        if (page === 1 && r.list.length) await this.coverCheck(r.list[0].imageUrl);
        return r;
    }

    // [임시 진단] 표지가 안 떠서: 첫 표지를 확장 통신으로 받아 본 결과를 필터 맨 위 🩺 줄에 (원인 찾으면 뺄 것)
    async coverCheck(img) {
        const one = async (name, headers, client) => {
            try {
                const res = await client.get(img, headers);
                const ct = String((res.headers && (res.headers["content-type"] || res.headers["Content-Type"])) || "?").split(";")[0];
                const b = String(res.body || "");
                return `${name} ${res.statusCode} ${ct} ${b.length}자${/Just a moment|cf-chl/i.test(b) ? " 보안확인" : ""}`;
            } catch (e) {
                return `${name} 실패 ${String((e && e.message) || e).substring(0, 40)}`;
            }
        };
        const out = [
            await one("확장헤더", this.getHeaders(img), new Client()),
            await one("UA넣음", { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` }, new Client()),
            await one("헤더없음", {}, new Client()),
        ];
        try {
            new SharedPreferences().setString("aniya24_cover_diag", `${img.substring(0, 90)} → ${out.join(" / ")}`);
        } catch (e) {}
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead(KEY, false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        if (/aniya24\d*\.[a-z]{2,6}\//i.test(query)) {
            const path = this.seriesPath(query.replace(/^(?!https?:\/\/)/, "https://"));
            if (path) {
                const d = await this.getDetail(path);
                return { list: [{ name: d.name, imageUrl: d.imageUrl, link: path }], hasNextPage: false };
            }
        }
        if (query) {
            const q = encodeURIComponent(query);
            const pre = page > 1 ? `/page/${page}/` : "/";
            let r = this.parseCards(await this.get(`${pre}?s=${q}&post_type=vidmov_series`, true), page);
            if (!r.list.length && page === 1) r = this.parseCards(await this.get(`/?s=${q}`, true), page);
            return r;
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
        const path = this.seriesPath(url) || url;
        const html = await this.get(path);
        const doc = new Document(html);
        const main = first(doc, "#main-content") || doc;
        const h1 = first(main, "h1.entry-title") || first(doc, "h1.entry-title");
        const ogTitle = (/<meta property="og:title" content="([^"]*)"/.exec(html) || [null, ""])[1];
        const title0 = decodeHtml(h1 ? h1.text.trim() : ogTitle).trim();
        const cats = [];
        for (const a of doc.select(".special-style a.category-item")) {
            const t = a.text.trim();
            if (t && !cats.includes(t)) cats.push(t);
        }
        // TMDB 칸 (있는 작품만)
        const banner = first(doc, ".tmdb-movie-banner");
        const bannerText = banner ? banner.text.replace(/\s+/g, " ") : "";
        const status = (/Status:\s*([A-Za-z ]+?)(?:\s+Release|\s+First|$|\s{2})/.exec(bannerText) || [null, ""])[1].trim();
        const release = (/(?:Release Date|First Air(?:ed| Date)?):\s*((?:19|20)\d{2})-(\d{2})-(\d{2})/i.exec(bannerText) || []);
        const orig = first(doc, ".tmdb-original-title");
        const genres = [];
        if (banner) {
            for (const s of banner.select(".item-text")) {
                const t = s.text.trim();
                if (t && !/:/.test(t) && !genres.includes(t)) genres.push(t);
            }
        }
        const modified = Date.parse((/article:modified_time" content="([^"]+)"/.exec(html) || [null, ""])[1]) || 0;

        // 회차 (사이트는 1화가 위로 보임) — 같은 영상(media-query-id)은 한 번만
        const raw = [];
        const seen = {};
        const groups = [];
        for (const item of doc.select(".main-series-items .series-item")) {
            const a = first(item, "a.post-listing-title") || first(item, "a[href]");
            if (!a) continue;
            const p = this.episodePath(a.attr("href"));
            const mid = (/media-query-id\/(\d+)/.exec(p || "") || [null, ""])[1];
            if (!p || !mid || seen[mid]) continue;
            seen[mid] = true;
            const g = (/group-query-id\/(\d+)/.exec(p) || [null, "0"])[1];
            if (!groups.includes(g)) groups.push(g);
            let label = decodeHtml(a.attr("title") || a.text || "").replace(/\s+/g, " ").trim();
            if (title0 && label.startsWith(title0) && label.length > title0.length) label = label.substring(title0.length).trim();
            else if (label === title0) label = "";
            // 회차 그림 = 그 회차 영상의 미리보기(…b-cdn.net/{영상ID}/thumbnail.jpg) → 재생 때 사이트를 다시 안 받으려고 주소 # 뒤에 적어 둠
            const im = first(item, "img");
            const tm = /^https:\/\/([^/]+\.b-cdn\.net)\/([0-9a-f-]{36})\//i.exec(im ? (im.attr("src") || im.attr("data-src") || "") : "");
            raw.push({ p: tm ? `${p}#bunny=${tm[1]}/${tm[2]}` : p, g, label });
        }
        // 회차 목록이 없으면 작품 화면 자체(첫 영상)를 하나로
        if (!raw.length && /beeteam368_pro_player\(/.test(html)) raw.push({ p: path, g: "0", label: "" });
        const numOf = (s) => {
            const m = /(\d+)\s*(?:화|회|話)/.exec(s) || /^(\d+)/.exec(s);
            return m ? Number(m[1]) : null;
        };
        // 망가요미는 최신이 위 → 1화가 위면 뒤집음
        const n0 = raw.length ? numOf(raw[0].label) : null;
        const n1 = raw.length ? numOf(raw[raw.length - 1].label) : null;
        const ascending = !(n0 !== null && n1 !== null && n0 > n1);
        const ordered = ascending ? raw.slice().reverse() : raw;
        const episodes = ordered.map((e, i) => {
            const label = e.label || title0;
            const name = /^\d/.test(label) ? label : `${ordered.length - i}. ${label}`;
            const ep = { name, url: e.p, dateUpload: null };
            if (groups.length > 1) ep.scanlator = `시즌${groups.indexOf(e.g) + 1}`;
            return ep;
        });

        const movie = cats.includes("극장판");
        let ongoing = false;
        if (/Returning|In Production|Planned/i.test(status)) ongoing = true;
        else if (/Ended|Released|Canceled/i.test(status) || movie) ongoing = false;
        else ongoing = modified > 0 && Date.now() - modified < 21 * 86400000;
        const year = release[1] || "";
        let title = title0;
        if (ongoing && modified) title = `${title} · ${mmdd(modified)}`;
        else if (year && !title.includes(`(${year})`)) title = `${title} (${year})`;

        const ogImage = (/<meta property="og:image" content="([^"]+)"/.exec(html) || [null, ""])[1];
        const poster = first(doc, "img.tmdb-picture");
        const bodyEl = first(doc, ".entry-content-in-single");
        let story = bodyEl ? bodyEl.text.replace(/\s+\n/g, "\n").trim() : "";
        if (story.endsWith(title0)) story = story.substring(0, story.length - title0.length).trim();
        const info = [
            orig ? `원제: ${orig.text.trim()}` : "",
            release[1] ? `${movie ? "개봉" : "방영"}: ${release[1]}.${release[2]}.${release[3]}` : "",
            cats.length ? `분류: ${cats.join(", ")}` : "",
        ].filter((x) => x).join("\n");
        return {
            name: title,
            imageUrl: this.abs(ogImage || (poster ? poster.attr("src") : "")),
            link: this.getBaseUrl() + path,
            description: [ongoing && modified ? `방영 중 · 최근 갱신: ${fullDate(modified)}` : "", story, info].filter((x) => x).join("\n\n"),
            author: "",
            status: ongoing ? 0 : 1,
            genre: cats.filter((c) => !/^TV Shows$/i.test(c)).concat(genres.filter((g) => !cats.includes(g))),
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        // [임시 측정] 화질 이름 뒤에 확장 처리 시간 (원인 찾으면 뺄 것)
        const t0 = Date.now();
        const tag = (list) => list.map((v) => Object.assign(v, { quality: `${v.quality} [${((Date.now() - t0) / 1000).toFixed(1)}초${this.fast ? " 바로" : ""}]` }));
        this.fast = false;
        const fm = /#bunny=([^/]+\.b-cdn\.net)\/([0-9a-f-]{36})/i.exec(String(url || ""));
        if (fm) {
            const u = `https://${fm[1]}/${fm[2]}/playlist.m3u8`;
            const mh = { "User-Agent": UA, "Referer": `${PLAYER_ORIGIN}/`, "Origin": PLAYER_ORIGIN };
            const list = await hlsExpand(this.client, u, LABEL, mh);
            // 목록을 읽었으면(화질이 붙음) 바로, 아니면 회차 화면에서 찾음
            if (list.length > 1 || /\d+p$/.test(list[0].quality)) {
                this.fast = true;
                if (list.length === 1) {
                    // 화질이 하나뿐이면 그 화질 목록 주소를 바로 넘김 (재생기가 한 단계 덜 거침)
                    const v = await this.singleVariant(u, mh);
                    if (v) list[0].url = list[0].originalUrl = v;
                }
                return tag(qualitySort("aniya24_quality", list));
            }
        }
        return tag(await this.videoListSlow(url));
    }

    async singleVariant(master, headers) {
        try {
            const res = await this.client.get(master, headers);
            const lines = String(res.body || "").replace(/\r/g, "").split("\n").filter((x) => x && !x.startsWith("#"));
            if (lines.length !== 1) return null;
            const l = lines[0].trim();
            return /^https?:\/\//.test(l) ? l : master.replace(/[^/]*(?:\?.*)?$/, "") + l;
        } catch (e) {
            return null;
        }
    }

    async videoListSlow(url) {
        url = String(url || "").replace(/#.*$/, "");
        const path = this.episodePath(url) || this.seriesPath(url) || url;
        const pageUrl = this.getBaseUrl() + path;
        const html = await this.get(path);
        const diag = [];
        // 플레이어 설정 beeteam368_pro_player({...}) — 광고 영상(video_ads_params)이 같이 들어 있어 video_url 만 씀
        let cfg = null;
        const at = html.indexOf("beeteam368_pro_player(");
        if (at >= 0) {
            const block = braceBlock(html, html.indexOf("{", at));
            try {
                cfg = JSON.parse(block);
            } catch (e) {
                diag.push("설정 읽기 실패");
            }
        } else diag.push("플레이어 설정 없음");
        const vurl = String((cfg && cfg.video_url) || "");
        const poster = String((cfg && cfg.video_poster) || "");
        const label = LABEL;
        const bunny = /mediadelivery\.net\/(?:embed|play)\/(\d+)\/([0-9a-f-]{36})/i.exec(vurl);
        const mediaHeaders = { "User-Agent": UA, "Referer": `${PLAYER_ORIGIN}/`, "Origin": PLAYER_ORIGIN };
        if (bunny) {
            const guid = bunny[2];
            const cands = [];
            const pm = new RegExp(`^https://([^/]+\\.b-cdn\\.net)/${guid}/`, "i").exec(poster);
            if (pm) cands.push(`https://${pm[1]}/${guid}/playlist.m3u8`);
            for (const c of cands) {
                const l = await hlsExpand(this.client, c, label, mediaHeaders);
                if (l.length > 1 || /\d+p$/.test(l[0].quality)) return qualitySort("aniya24_quality", l);
                diag.push("직접 주소 안 열림");
            }
            // 플레이어 화면에 적힌 재생 목록 주소
            try {
                const emb = await this.client.get(`${PLAYER_ORIGIN}/embed/${bunny[1]}/${guid}`, { "User-Agent": UA, "Referer": pageUrl });
                const m = new RegExp(`https://[^"'\\s]+/${guid}/playlist\\.m3u8[^"'\\s]*`).exec(String(emb.body || ""));
                if (m) {
                    const u = m[0].replace(/&amp;/g, "&");
                    return qualitySort("aniya24_quality", await hlsExpand(this.client, u, label, mediaHeaders));
                }
                diag.push(`플레이어 화면 ${emb.statusCode} · 목록 주소 없음`);
            } catch (e) {
                diag.push("플레이어 화면 실패");
            }
        } else if (/\.(?:m3u8|mp4)(?:[?"'\s]|$)/i.test(vurl)) {
            const m = /https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/i.exec(vurl);
            if (m) {
                const h = { "User-Agent": UA, "Referer": pageUrl };
                return qualitySort("aniya24_quality", await hlsExpand(this.client, m[0], label, h));
            }
        } else if (vurl) {
            diag.push("다른 플레이어: " + ((/src=\\?"(https?:\/\/[^/"\\]+)/.exec(vurl) || [null, vurl.substring(0, 40)])[1]));
        }
        throw new Error(`${LABEL} 영상을 찾지 못했어요 [${diag.join(" | ") || "주소 없음"}]`);
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${host}` },
            ...notesFilters(KEY),
            ...(() => {
                let d = "";
                try {
                    d = new SharedPreferences().getString("aniya24_cover_diag", "") || "";
                } catch (e) {}
                return d ? [{ type_name: "HeaderFilter", name: `🩺 표지 확인: ${d}`, _status: true }] : [];
            })(),
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), ruleFilters(KEY, RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: "aniya24_domain",
            editTextPreference: {
                title: "애니야24 주소 직접 지정 (선택)",
                summary: `비워 두면 기본 주소(${DEFAULT_BASE_URL})를 사용합니다.`,
                value: "",
                dialogTitle: "애니야24 주소",
                dialogMessage: "https:// 로 시작하는 애니야24 주소 (예: https://www.aniya24.com)",
            },
        }, qualityPreference("aniya24_quality")];
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
const VER_INDEX_URLS = ["https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/mangayomi/anime_index.json", "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/index.json"];

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
