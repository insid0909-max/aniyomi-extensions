const mangayomiSources = [{
    "name": "애니울프",
    "lang": "ko",
    "baseUrl": "https://aniwolf.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.2",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/aniwolf.js"
}];

// 애니울프(aniwolf.com, 2026-11-04, 해외에서도 열려 실제 구조 확인 후 만듦. 코티비씨·툰코와 같은 계열 사이트)
// 목록: /?menu=ing&day={u|1..6|0}&sort={new|hot}&page=N (방영중), /?menu=fin|film&sort=&page= (종영·극장판),
//   /?menu=rank&period={now|day|week|month} (순위, 한 쪽), 검색 /?search=검색어&page=N. 카드 .animation-card a[title] + img, 연도·화수 .animation-year
// 작품: /{slug} (정보 table td, 회차 .bg-episode a + 날짜 "2026/11/02", 한 화면에 모든 회차), 회차: /{slug}/{N화}
// 재생: 회차 화면의 mov.glamov.com/detail.php?v={ID} → 그 화면의 iframe(cdndania.com/video/{ID}) = 애니24와 같은 플레이어
//   → 애니24에서 망가요미 재생이 확인된 dcVideos 그대로
const DEFAULT_BASE_URL = "https://aniwolf.com";
const DOMAIN_RE = /^https:\/\/(?:www\.)?aniwolf\d*\.[a-z]{2,6}$/;
const HOST_RE = /^https?:\/\/(?:www\.)?aniwolf\d*\.[a-z]{2,6}(?=\/|$)/;
const LABEL = "애니울프";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함)
const KINDS = [["방영중", "ing"], ["종영", "fin"], ["극장판", "film"], ["순위", "rank"]];
const DAYS = [["전체", "u"], ["월", "1"], ["화", "2"], ["수", "3"], ["목", "4"], ["금", "5"], ["토", "6"], ["일", "0"]];
const SORTS = [["최신", "new"], ["인기", "hot"]];
const PERIODS = [["실시간", "now"], ["일간", "day"], ["주간", "week"], ["월간", "month"]];
const FILTER_DEFS = [
    ["분류", "kind", KINDS.map((k) => k[0])],
    ["요일 (방영중만)", "day", DAYS.map((d) => d[0])],
    ["정렬 (순위 빼고)", "sort", SORTS.map((d) => d[0])],
    ["순위 기간 (순위만)", "period", PERIODS.map((d) => d[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [0, 0, 1, 0];
const DEFAULT_LATEST = [0, 0, 0, 0];

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

function ruleText(i) {
    const k = i[0];
    return [
        KINDS[k][0],
        k === 0 && i[1] > 0 ? DAYS[i[1]][0] : null,
        k === 3 ? PERIODS[i[3]][0] : SORTS[i[2]][0],
    ].filter((x) => x).join(" · ");
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
            custom = (new SharedPreferences().get("aniwolf_domain") || "").trim().replace(/\/+$/, "");
        } catch (e) {
            custom = "";
        }
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    async get(path, referer) {
        const base = this.getBaseUrl();
        const url = /^https?:\/\//.test(path) ? path : base + path;
        const h = Object.assign(this.getHeaders(), referer ? { "Referer": referer } : {});
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
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 (HTTP ${res.statusCode}). 주소가 바뀌었으면 설정에서 새 주소를 넣어 주세요.`);
        return String(res.body || "");
    }

    /** "https://aniwolf.com/원피스/001화" → "/원피스/001화" (작품·회차 주소만, 메뉴 주소 제외) */
    pathOf(href) {
        let p = String(href || "").trim();
        if (/^https?:\/\//.test(p)) {
            if (!HOST_RE.test(p)) return null;
            p = p.replace(HOST_RE, "");
        }
        p = safeDecode(p.split("#")[0].split("?")[0]);
        if (!/^\/[^/]+(\/[^/]+)?$/.test(p)) return null;
        if (/^\/(history|community|bookmark|signin|signup|go|assets|storage|api|img)(\/|$)/.test(p)) return null;
        return p;
    }

    // ================= 목록 =================
    listPath(idx, page) {
        const k = KINDS[idx[0]][1];
        if (k === "rank") return `/?menu=rank&period=${PERIODS[idx[3]][1]}`;
        const q = [`menu=${k}`];
        if (k === "ing") q.push(`day=${DAYS[idx[1]][1]}`);
        q.push(`sort=${SORTS[idx[2]][1]}`);
        if (page > 1) q.push(`page=${page}`);
        return "/?" + q.join("&");
    }

    /** 목록 화면의 작품 카드 (.animation-card) */
    parseCards(html, page) {
        const doc = new Document(html);
        const seen = {};
        const list = [];
        for (const card of doc.select(".animation-card")) {
            const a = first(card, "a[href]");
            if (!a) continue;
            const path = this.pathOf(a.attr("href"));
            if (!path || seen[path]) continue;
            seen[path] = true;
            let title = decodeHtml(a.attr("title") || "").trim();
            const typeEl = first(card, ".animation-type");
            const yearEl = first(card, ".animation-year");
            const type = typeEl ? typeEl.text.trim() : "";
            const year = ((yearEl ? yearEl.text : "").match(/^\s*((?:19|20)\d{2})\s*$/) || [])[1];
            // 종영·극장판은 제목 뒤에 연도 (방영중 카드는 화수만 있어 날짜를 붙일 수 없음)
            if (year && type !== "방영중" && !title.includes(`(${year})`)) title = `${title} (${year})`;
            const img = first(card, "img");
            // 늦게 뜨는 그림(class=lazy)은 data-src 가 진짜 그림
            const src = img ? (img.attr("data-src") || img.attr("data-original") || img.attr("src")) : "";
            list.push({ name: title, imageUrl: this.abs(src), link: path });
        }
        const next = new RegExp(`[?&]page=${page + 1}(?:&|"|$)`).test(html.replace(/&amp;/g, "&"));
        return { list, hasNextPage: next };
    }

    abs(u) {
        u = String(u || "");
        if (!u || /^https?:\/\//.test(u)) return u;
        return this.getBaseUrl() + (u.startsWith("/") ? u : "/" + u);
    }

    async listPage(idx, page) {
        if (KINDS[idx[0]][1] === "rank" && page > 1) return { list: [], hasNextPage: false };
        return this.parseCards(await this.get(this.listPath(idx, page)), page);
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return this.listPage(ruleRead("aniwolf", true, RULE_SIZES) || DEFAULT_POPULAR, page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead("aniwolf", false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        if (/aniwolf\d*\.[a-z]{2,6}\//.test(query)) {
            const path = this.pathOf(query.replace(/^(?!https?:\/\/)/, "https://"));
            if (path) {
                const work = "/" + path.split("/")[1];
                const d = await this.getDetail(work);
                return { list: [{ name: d.name, imageUrl: d.imageUrl, link: work }], hasNextPage: false };
            }
        }
        if (query) {
            const q = [`search=${encodeURIComponent(query)}`];
            if (page > 1) q.push(`page=${page}`);
            return this.parseCards(await this.get("/?" + q.join("&")), page);
        }
        const idx = [0, 0, 0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), RULE_SIZES[k] - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (rule) ruleApply("aniwolf", rule, idx);
        return this.listPage(idx, page);
    }

    // ================= 작품 정보 · 회차 =================
    async getDetail(url) {
        const path = "/" + String(this.pathOf(url) || url).split("/")[1];
        const html = await this.get(encodeURI(path));
        const doc = new Document(html);
        const meta = {};
        for (const tr of doc.select(".detail-description table tr")) {
            const td = tr.select("td");
            const v = td.length >= 2 ? td[1].text.trim() : "";
            if (v && v !== "정보없음") meta[td[0].text.trim()] = v;
        }
        const h1 = first(doc, "h1.aw-h1") || first(doc, ".detail-title h1");
        const title0 = h1 ? h1.text.trim() : "";
        const raw = [];
        const seen = {};
        for (const row of doc.select(".bg-episode")) {
            const a = first(row, "a[href]");
            if (!a) continue;
            const p = this.pathOf(a.attr("href"));
            if (!p || seen[p] || p.split("/").length < 3) continue;
            seen[p] = true;
            // 지금 보는 회차 표시 "(시청중)" 은 뺌, 앞의 작품 제목도 뺌 (극장판은 "제목 제목" 처럼 두 번 붙음)
            let label = a.text.replace(/\(시청중\)/g, "").replace(/\s+/g, " ").trim();
            while (title0 && label.startsWith(title0) && label.length > title0.length) label = label.substring(title0.length).trim();
            const span = first(row, ".text-white-50");
            raw.push({ p, label: label || p.split("/")[2], date: dayMs(span ? span.text : "") });
        }
        // 방영 중: 정보 "총화수" 칸이 "방영중" 이거나 경로(BreadcrumbList) 두 번째가 "방영중"
        const ongoing = /방영중/.test(meta["총화수"] || "") || /"position":2,"name":"방영중"/.test(html);
        const latest = Math.max(0, ...raw.map((e) => e.date));
        // 사이트는 최신 회차가 위. 회차 이름은 회차 번호로 시작 (망가요미가 맨 앞 숫자를 회차로 읽음)
        const episodes = raw.map((e, i) => {
            const num = /^\D*?(\d+)/.exec(e.label);
            const name = (num && /^\d/.test(e.label) ? e.label : `${raw.length - i}. ${e.label}`) + (e.date ? ` (${mmdd(e.date)})` : "");
            return { name, url: e.p, dateUpload: e.date ? String(e.date) : null };
        });
        const year = ((meta["방영일"] || meta["상영일"] || meta["개봉일"] || "").match(/(?:19|20)\d{2}/) || [""])[0];
        let title = title0;
        if (ongoing && latest) title = `${title} · ${mmdd(latest)}`;
        else if (!ongoing && year && !title.includes(`(${year})`)) title = `${title} (${year})`;
        const img = first(doc, ".detail-description .animation-image img");
        const synM = /detail-synopsis[\s\S]*?<span class="text-default">([\s\S]*?)<\/span>/.exec(html);
        const story = synM ? decodeHtml(synM[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).split("\n").map((x) => x.trim()).filter((x) => x).join("\n").trim() : "";
        const info = ["원제", "원작", "감독", "각본", "작화", "음악", "방영일", "상영일", "등급", "총화수", "런타임"].filter((k) => meta[k]).map((k) => `${k}: ${meta[k]}`).join("\n");
        return {
            name: title,
            imageUrl: img ? this.abs(img.attr("src")) : "",
            link: this.getBaseUrl() + encodeURI(path),
            description: [ongoing && latest ? `방영 중 · 최근 방영: ${fullDate(latest)}` : "", story, info].filter((x) => x).join("\n\n"),
            author: meta["원작"] || "",
            status: ongoing ? 0 : 1,
            genre: (meta["장르"] || "").split(/[,/·]/).map((x) => x.trim()).filter((x) => x),
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        const path = this.pathOf(url) || url;
        const pageUrl = this.getBaseUrl() + encodeURI(path);
        const html = await this.get(encodeURI(path));
        // 회차 화면의 재생 버튼 주소(mov.glamov.com/detail.php?v=…) → 그 화면의 iframe 이 플레이어(cdndania.com/video/…)
        const views = [...new Set((html.match(/https?:\/\/[^"'\s<>]+\/detail\.php\?v=[0-9a-zA-Z]+/g) || []))];
        const ids = [...new Set((html.match(/name="v"\s+value="([0-9a-zA-Z]+)"/g) || []).map((m) => /value="([^"]+)"/.exec(m)[1]))];
        for (const id of ids) if (!views.some((v) => v.endsWith("=" + id))) views.push(`https://mov.glamov.com/detail.php?v=${id}`);
        const players = [];
        for (const v of views) {
            try {
                const ph = await this.get(v, pageUrl);
                for (const m of ph.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/g) || []) {
                    const src = /src="([^"]+)"/.exec(m)[1];
                    if (!/googlesyndication|doubleclick|ads/.test(src) && !players.includes(src)) players.push(src);
                }
            } catch (e) {
                // 다음 재생 화면
            }
        }
        // 회차 화면에 플레이어가 바로 있는 경우도
        for (const m of html.match(/<iframe[^>]+src="(https?:\/\/[^"]*(?:cdndania|michealcdn|\/video\/)[^"]*)"/g) || []) {
            const src = /src="([^"]+)"/.exec(m)[1];
            if (!players.includes(src)) players.push(src);
        }
        if (!players.length) throw new Error(`이 회차에는 재생 화면이 없습니다 [재생 버튼 ${views.length}개]`);
        let list = [];
        const fails = [];
        this.diag = [];
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            const label = i === 0 ? LABEL : `${LABEL} (대체 ${i})`;
            const origin = (/^(https?:\/\/[^/]+)/.exec(player) || [null, ""])[1];
            // 1) DC 애니24(망가요미판)와 똑같은 방법 (망가요미에서 재생 확인된 방법)
            const dc = await this.dcVideos(player, origin, label);
            if (dc.length) {
                list = list.concat(dc);
                continue;
            }
            // 2) 안 되면 기존 방법: 플레이어 POST → 플레이어 화면 → 웹뷰
            const fire = (await this.firePlayer(player, pageUrl)) || (await this.playerPage(player, pageUrl));
            let found = fire ? fire.url : null;
            if (!fire || !fire.sure) {
                const w = await this.viaWebview(player, pageUrl);
                if (w) found = w;
            }
            if (!found) {
                fails.push((/^https?:\/\/([^/]+)/.exec(player) || [null, player])[1]);
                continue;
            }
            // DC 애니24(망가요미판)와 같은 영상 요청 정보
            const h = { "User-Agent": UA, "Referer": `${origin}/`, "Origin": origin };
            // DC 방법이 실패해서 예비 방법으로 찾은 영상은 이름에 표시 (실패 이유는 이름 끝 [ ])
            const got = (await this.expand(found, label, h)).map((g) => Object.assign(g, { quality: `${g.quality} (예비) [${this.diag.join(" · ").substring(0, 60)}]` }));
            list = list.concat(got);
            // 화질이 하나뿐이면 원래 목록 주소도 함께 (재생기에 따라 이쪽이 잘 될 수 있음)
        }
        // 재생 목록 주소가 .m3u8 로 끝나지 않으면(master.txt 등) 망가요미 재생기가 HLS 로 알아보지 못하고
        // 조각을 하나씩 따로 재생함(10초짜리로 끊김) → 재생용 주소(originalUrl) 끝에 "#download.m3u8" 를 붙여 HLS 로 알림.
        // # 뒤는 서버로 보내지지 않아 실제 요청은 그대로 (DC 애니24 망가요미판과 같은 방법)
        for (const v of list) {
            const plain = String(v.url || "").replace(/#.*$/, "");
            v.originalUrl = /\.m3u8?$/i.test(plain.split("?")[0]) ? plain : plain + "#download.m3u8";
        }
        if (!list.length) {
            const wv = typeof evaluateJavascriptViaWebview === "function" ? "" : " · 웹뷰 미지원";
            throw new Error(`영상 주소를 찾지 못했습니다 [${fails.join(", ")}${wv} · ${this.diag.join(" · ")}]`);
        }
        return qualitySort("aniwolf_quality", list);
    }

    /**
     * 화질 나누기. 이 플레이어의 재생 목록은 주소 끝에 .m3u8 이 없으므로(/m3/…, master.txt)
     * 주소 모양 대신 내용(#EXTM3U)을 보고 화질 목록이면 화질별로 나눔 (자동 화질 바꿈으로 자주 멈추는 것을 피하게)
     */
    /** DC 애니24(망가요미판)의 재생 부분을 그대로 옮김: 별도 통신(Client 옵션)으로 POST → securedLink → 화질 목록 */
    async dcVideos(player, origin, label) {
        const transports = [
            { persistentConnection: false, noProxy: true, timeout: 25, connectTimeout: 10 },
            { useDartHttpClient: true, persistentConnection: false },
        ];
        const req = async (fn) => {
            let last = null;
            for (const opt of transports) {
                try {
                    const r = await fn(new Client(opt));
                    if (r && r.statusCode >= 200 && r.statusCode < 300) return String(r.body || "");
                    last = `HTTP${r ? r.statusCode : "?"}`;
                } catch (e) {
                    last = String((e && e.message) || e).substring(0, 40);
                }
            }
            throw new Error(last || "실패");
        };
        try {
            let id = player.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
            if (!/^[a-f0-9]{16,}$/i.test(id)) {
                const embedded = await req((c) => c.get(player, { "User-Agent": UA, "Referer": this.getBaseUrl() + "/" }));
                const fm = embedded.match(/FirePlayer\s*\(\s*["']([^"']+)/i);
                if (fm) id = fm[1];
            }
            if (!id) return [];
            const body = await req((c) => c.post(`${origin}/player/index.php?data=${encodeURIComponent(id)}&do=getVideo`, {
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                "Referer": player,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Origin": origin,
            }, { hash: id, r: "" }));
            const data = JSON.parse(body);
            let masterUrl = String(data.securedLink || data.link || "").replace(/\\\//g, "/");
            if (!masterUrl) return [];
            if (masterUrl.startsWith("//")) masterUrl = "https:" + masterUrl;
            else if (masterUrl.startsWith("/")) masterUrl = origin + masterUrl;
            const master = await req((c) => c.get(masterUrl, { "User-Agent": UA, "Accept": "*/*", "Referer": player }));
            const headers = { "User-Agent": UA, "Referer": `${origin}/`, "Origin": origin };
            const out = [];
            const lines = master.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
                let next = "";
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].trim() && lines[j].indexOf("#") !== 0) {
                        next = lines[j].trim();
                        break;
                    }
                }
                if (!next) continue;
                const height = (lines[i].match(/RESOLUTION=\d+x(\d+)/i) || [])[1];
                const u = /^https?:\/\//.test(next) ? next : next.startsWith("/") ? (/^(https?:\/\/[^/]+)/.exec(masterUrl) || [null, ""])[1] + next : masterUrl.replace(/[?#].*$/, "").replace(/[^/]*$/, "") + next;
                out.push({ url: u, originalUrl: u, quality: height ? `${label} ${height}p` : label, headers, subtitles: [] });
            }
            if (!out.length) out.push({ url: masterUrl, originalUrl: masterUrl, quality: `${label} 자동`, headers, subtitles: [] });
            return out;
        } catch (e) {
            this.diag.push(`DC방식 ${String((e && e.message) || e).substring(0, 50)}`);
            return [];
        }
    }

    /** 플레이어 화면(cdndania.com/video/…)의 스크립트에서 securedLink 를 찾음 (압축된 스크립트는 풀어서) */
    async playerPage(player, pageUrl) {
        try {
            const res = await this.client.get(player, { "User-Agent": UA, "Referer": pageUrl });
            if (res.statusCode >= 400) {
                this.diag.push(`플레이어 ${res.statusCode}`);
                return null;
            }
            let html = String(res.body || "");
            const packed = html.match(/eval\(function\(p,a,c,k,e,[dr]\)[\s\S]*?\.split\('\|'\)[^)]*\)\)/g) || [];
            for (const p of packed) html += "\n" + unpack(p);
            const text = html.replace(/\\\//g, "/");
            const m = /securedLink"?\s*:\s*"([^"]+)"/.exec(text);
            if (m && /^https?:\/\//.test(m[1])) return { url: m[1], sure: true };
            this.diag.push(`플레이어에 securedLink 없음${packed.length ? "(압축 " + packed.length + ")" : ""}`);
            return null;
        } catch (e) {
            this.diag.push(`플레이어 열기 실패 ${String((e && e.message) || e).substring(0, 40)}`);
            return null;
        }
    }

    async expand(url, label, h) {
        if (/\.m3u8/.test(url)) return hlsExpand(this.client, url, label, h);
        const one = [{ url, originalUrl: url, quality: label, headers: h }];
        if (/\.mp4(\?|$)/.test(url)) return one;
        let body = "";
        try {
            const res = await this.client.get(url, h);
            if (Number(res.statusCode) >= 400) return one;
            body = String(res.body || "").replace(/\r/g, "");
        } catch (e) {
            return one;
        }
        if (!body.trim().startsWith("#EXTM3U")) return one;
        const origin = (/^(https?:\/\/[^/]+)/.exec(url) || [null, ""])[1];
        const dir = url.replace(/[^/]*(?:\?.*)?$/, "");
        const seen = {};
        const variants = [];
        const re = /#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)/g;
        let m;
        while ((m = re.exec(body))) {
            const hh = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
            const height = hh ? Number(hh[1]) : 0;
            let u = m[2].trim();
            if (!/^https?:\/\//.test(u)) u = u.startsWith("/") ? origin + u : dir + u;
            const key = height || u;
            if (seen[key]) continue;
            seen[key] = true;
            variants.push({ h: height, u });
        }
        if (!variants.length) {
            // 화질이 하나뿐인 재생 목록: 조각 주소의 화질(예: /720p/)을 이름에 붙임
            const r = /\/(2160|1440|1080|720|480|360)p\//.exec(body);
            return [{ url, originalUrl: url, quality: r ? `${label} ${r[1]}p` : label, headers: h }];
        }
        variants.sort((a, b) => b.h - a.h);
        if (variants.length === 1) return [{ url: variants[0].u, originalUrl: variants[0].u, quality: variants[0].h ? `${label} ${variants[0].h}p` : label, headers: h }];
        return variants.map((v) => ({ url: v.u, originalUrl: v.u, quality: v.h ? `${label} ${v.h}p` : label, headers: h }))
            .concat([{ url, originalUrl: url, quality: `${label} 자동 (최대 ${variants[0].h}p)`, headers: h }]);
    }

    /**
     * 플레이어(michealcdn 등)가 스스로 부르는 영상 주소 요청을 그대로 함:
     * POST {플레이어}/player/index.php?data={영상ID}&do=getVideo (hash={영상ID}, r={회차 화면}) → 응답 안의 m3u8
     */
    async firePlayer(player, pageUrl) {
        const m = /^(https?:\/\/[^/]+)\/.*?([^/?#]+)(?:[?#].*)?$/.exec(player);
        if (!m) return null;
        try {
            // DC 애니24와 같게: Referer·Origin 은 플레이어 주소의 앞부분, 본문은 hash={영상ID}, r=(빈 값)
            const res = await this.client.post(`${m[1]}/player/index.php?data=${m[2]}&do=getVideo`, {
                "X-Requested-With": "XMLHttpRequest",
                "Referer": m[1],
                "Origin": m[1],
            }, { hash: m[2], r: "" });
            const text = String(res.body || "").replace(/\\\//g, "/");
            if (res.statusCode >= 400) {
                this.diag.push(`요청 ${res.statusCode}`);
                return null;
            }
            // 애니요미와 같이 응답 안의 첫 .m3u8 주소를 먼저 씀. /m3/… 주소는 앞부분 몇 초짜리 목록이라
            // 재생기가 실시간 방송처럼 몇 초마다 목록을 다시 받으며 멈춤 → .m3u8 이 없을 때만 다른 주소
            // 응답의 securedLink 가 영상 전체 재생 목록 (다른 애니24 확장앱도 이 칸을 씀).
            // videoSource(/m3/…)는 앞부분 몇 초짜리라 재생기가 실시간 방송처럼 몇 초마다 멈춤
            let data = null;
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = null;
            }
            const secured = data && typeof data.securedLink === "string" && /^https?:\/\//.test(data.securedLink) ? data.securedLink : null;
            if (secured) return { url: secured, sure: true };
            const m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(text);
            if (m3u8) return { url: m3u8[0], sure: true };
            const pick = data && ["videoSource", "file", "hls", "src"].map((k) => data[k])
                .find((v) => typeof v === "string" && /^https?:\/\//.test(v));
            const v = pick || (/https?:\/\/[^"'\s<>]+(?:\/m3\/|master\.txt)[^"'\s<>]*/.exec(text) || [])[0];
            if (!v) this.diag.push(`응답 "${text.replace(/\s+/g, " ").substring(0, 60)}"`);
            return v ? { url: v, sure: false } : null;
        } catch (e) {
            this.diag.push(`요청 실패 ${String((e && e.message) || e).substring(0, 40)}`);
            return null;
        }
    }

    /** 숨은 웹뷰로 플레이어를 열고, 플레이어가 부른 m3u8 주소를 돌려받음 */
    async viaWebview(player, pageUrl) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        // .m3u8 주소를 먼저 찾고, 8초가 지나도 없으면 /m3/… · master.txt 주소라도 돌려줌
        const script = "(function(){var n=0;function find(re){var r=performance.getEntriesByType('resource');" +
            "for(var i=0;i<r.length;i++){if(re.test(r[i].name))return r[i].name;}return null;}" +
            "var t=setInterval(function(){n++;var u=find(/\\.m3u8(\\?|$)/)||(n>26?find(/\\/m3\\/|master\\.txt/):null);" +
            "if(u){clearInterval(t);window.flutter_inappwebview.callHandler('setResponse',u);return;}" +
            "if(n===20){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.jw-icon-display,.vjs-big-play-button,.plyr__control--overlaid');if(b)b.click();}},300);})();";
        try {
            const timeout = new Promise((res) => setTimeout(() => res(null), 20000));
            const res = await Promise.race([evaluateJavascriptViaWebview(player, { "Referer": pageUrl }, [script]), timeout]);
            if (!res) this.diag.push("웹뷰에서도 못 찾음");
            return res && /^https?:\/\//.test(String(res)) ? String(res) : null;
        } catch (e) {
            return null;
        }
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${host}` },
            ...notesFilters("aniwolf"),
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), ruleFilters("aniwolf", RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: "aniwolf_domain",
            editTextPreference: {
                title: "애니울프 주소 직접 지정 (선택)",
                summary: `비워 두면 기본 주소(${DEFAULT_BASE_URL})를 사용합니다.`,
                value: "",
                dialogTitle: "애니울프 주소",
                dialogMessage: "https:// 로 시작하는 애니울프 주소 (예: https://aniwolf.com)",
            },
        }, qualityPreference("aniwolf_quality")];
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
        if (!q || Number(page) > 1 || /[/.:]/.test(q) || (r && r.list && r.list.length)) return r;
        const squash = (s) => String(s || "").normalize("NFC").replace(/[\s\-_:·.,!?~'"()[\]{}]/g, "").toLowerCase();
        const want = squash(q);
        if (want.length < 2) return r;
        const joined = q.replace(/\s+/g, "");
        const tries = [];
        const add = (t) => { if (t && t.length >= 2 && t !== q && tries.indexOf(t) < 0) tries.push(t); };
        add(joined);
        if (joined.length > 2) add(joined.substring(0, Math.max(2, Math.ceil(joined.length / 2))));
        for (let i = 0; i + 2 <= joined.length; i++) add(joined.substring(i, i + 2));
        for (const t of tries.slice(0, 6)) {
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
        for (const e of eps) e.name = movieName(e.name);
        if (d.status === 5 || d.status === undefined) d.status = 1;
        return d;
    };
})();
