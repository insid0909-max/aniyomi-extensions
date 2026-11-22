const mangayomiSources = [{
    "name": "링크애니",
    "lang": "ko",
    "baseUrl": "https://linkani.tv",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.2",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/linkani.js"
}];

// 2026-11-15 정식 0.1.0 (새 id 1543270645, 사용자 "정식판 올려" — 시험판 0.0.1~0.0.2 휴대폰 목록·재생 확인): 11-01 에 지운 옛 정식판(id 1543270637, 한국 접속 차단이었음) 코드 + 다른 확장 공통 기능(애니위크 끝부분: 📝 설치 버전·필터 빈 줄·검색 띄어쓰기·영화 본편·회차 번호 겹침 막기, 주소 못 찾음 안내)
// Aniyomi Linkani.kt(링크애니, linkani.tv "Linkkf 애니 TV")를 망가요미용으로 옮긴 소스.
// 목록: /list/2/(전체) · /list/9/(Ani16+) [/class/{장르·요일}][/year/{연도}][/lang/{TV|Movie|OVA}][/page/N/],
//   인기: /label/topday/[page/N/], 검색: /view/[page/N/]?wd=검색어 — 카드 div.vod-item
// 작품: /ani/{번호}/ (정보 .detail-info-desc li, 회차 .episode-box a.ep — 최신이 위, 회차 날짜는 사이트에 없음)
// 회차: /watch/{번호}/a1/k{N}/ 화면 안 var player_aaaa={…} 의 actual_url(m3u8)·subtitle_url(한국어 vtt).
//   영상 주소에 짧은 기한(expires)이 붙어 있어 재생할 때마다 회차 화면을 새로 읽음.
const DEFAULT_BASE_URL = "https://linkani.tv";
const DOMAIN_RE = /^https:\/\/(?:www\.)?(?:linkani\d*|linkkf\d*)\.[a-z]{2,6}$/;
const HOST_RE = /^https?:\/\/(?:www\.)?(?:linkani\d*|linkkf\d*)\.[a-z]{2,6}(?=\/|$)/;
const LABEL = "링크애니";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함)
const LISTS = [["전체 애니", "/list/2/"], ["Ani16+", "/list/9/"], ["오늘 인기 순위", "/label/topday/"]];
const RANKING = 2;
const GENRES = [
    ["전체", ""], ["액션", "Action"], ["모험", "Adventure"], ["아방가르드", "Avant Garde"], ["BL", "Boys Love"],
    ["코미디", "Comedy"], ["드라마", "Drama"], ["판타지", "Fantasy"], ["GL(백합)", "Girls Love"], ["요리·음식", "Gourmet"],
    ["공포", "Horror"], ["미스터리", "Mystery"], ["로맨스", "Romance"], ["SF", "Sci-Fi"], ["일상", "Slice of Life"],
    ["스포츠", "Sports"], ["초자연", "Supernatural"], ["서스펜스", "Suspense"], ["청년(세이넨)", "Seinen"],
    ["소녀(쇼죠)", "Shoujo"], ["소년(쇼넨)", "Shounen"], ["밀리터리", "Military"], ["음악", "Music"], ["학원", "School"],
    ["웹툰 원작", "Webtoon"], ["중국 애니", "CN Animation"],
];
const DAYS = ["전체", "월", "화", "수", "목", "금", "토", "일"];
const YEARS = ["전체"];
for (let y = Math.max(2026, new Date().getFullYear()); y >= 1990; y--) YEARS.push(String(y));
const TYPES = [["전체", ""], ["TV", "TV"], ["극장판", "Movie"], ["OVA", "OVA"]];
const FILTER_DEFS = [
    ["목록", "list", LISTS.map((x) => x[0])],
    ["장르", "genre", GENRES.map((x) => x[0])],
    ["요일", "day", DAYS.map((d) => (d === "전체" ? d : `${d}요일`))],
    ["연도", "year", YEARS],
    ["종류", "type", TYPES.map((x) => x[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [RANKING, 0, 0, 0, 0];
const DEFAULT_LATEST = [0, 0, 0, 0, 0];

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


function ruleText(i) {
    if (i[0] === RANKING) return LISTS[RANKING][0];
    return [
        LISTS[i[0]][0],
        i[1] > 0 && i[2] === 0 ? GENRES[i[1]][0] : null,
        i[2] > 0 ? `${DAYS[i[2]]}요일` : null,
        i[3] > 0 ? YEARS[i[3]] : null,
        i[4] > 0 ? TYPES[i[4]][0] : null,
    ].filter((x) => x).join(" · ");
}

/** 화면 글 안 var player_aaaa={…}; 의 JSON (중괄호 짝을 한 글자씩 세어 끝을 찾음) */
function playerData(html) {
    const start = html.indexOf("player_aaaa");
    if (start < 0) return null;
    const brace = html.indexOf("{", start);
    if (brace < 0) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = brace; i < html.length; i++) {
        const c = html[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === "\"") quoted = false;
            continue;
        }
        if (c === "\"") quoted = true;
        else if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(html.substring(brace, i + 1));
                } catch (e) {
                    return null;
                }
            }
        }
    }
    return null;
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
            const p = new SharedPreferences();
            custom = (p.get("linkani_domain") || "").trim().replace(/\/+$/, "");
        } catch (e) {
            custom = "";
        }
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    async get(path) {
        const base = this.getBaseUrl();
        const url = /^https?:\/\//.test(path) ? path : base + path;
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, this.getHeaders());
            } catch (e) {
                if (attempt === 1) throw new Error(`링크애니 접속 실패: ${String((e && e.message) || e).substring(0, 80)}`);
                await new Promise((r) => setTimeout(r, 700));
            }
        }
        if (res.statusCode >= 400) throw new Error(`링크애니 접속 실패 (HTTP ${res.statusCode}). 주소가 바뀌었으면 설정에서 새 주소를 넣어 주세요.`);
        return String(res.body || "");
    }

    abs(u) {
        u = String(u || "").trim();
        if (!u) return "";
        if (/^https?:\/\//.test(u)) return u;
        if (u.startsWith("//")) return "https:" + u;
        return this.getBaseUrl() + (u.startsWith("/") ? "" : "/") + u;
    }

    /** "https://linkani.tv/ani/123/" → "/ani/123/" (작품 주소만) */
    pathOf(href) {
        let p = String(href || "").trim();
        if (/^https?:\/\//.test(p)) {
            if (!HOST_RE.test(p)) return null;
            p = p.replace(HOST_RE, "");
        }
        p = p.split("#")[0].split("?")[0];
        const m = /^\/ani\/(\d+)\/?$/.exec(p);
        return m ? `/ani/${m[1]}/` : null;
    }

    // ================= 목록 =================
    listPath(idx, page) {
        const pageSuffix = page > 1 ? `page/${page}/` : "";
        if (idx[0] === RANKING) return `/label/topday/${pageSuffix}`;
        let p = LISTS[idx[0]][1];
        // 사이트는 분류(class)를 하나만 받음 → 요일을 고르면 요일, 아니면 장르
        const cls = idx[2] > 0 ? DAYS[idx[2]] : idx[1] > 0 ? GENRES[idx[1]][1] : "";
        if (cls) p += `class/${encodeURIComponent(cls).replace(/%20/g, "+")}/`;
        if (idx[3] > 0) p += `year/${YEARS[idx[3]]}/`;
        if (idx[4] > 0) p += `lang/${TYPES[idx[4]][1]}/`;
        return p + pageSuffix;
    }

    /** 목록·검색 화면의 작품 카드(div.vod-item) */
    parseCards(html, path) {
        const doc = new Document(html);
        const seen = {};
        const list = [];
        for (const item of doc.select(".vod-list .vod-item")) {
            const a = first(item, "h3.vod-item-title a") || first(item, "a.vod-item-img");
            if (!a) continue;
            const link = this.pathOf(a.attr("href"));
            if (!link || seen[link]) continue;
            const h3 = first(item, "h3.vod-item-title");
            let title = decodeHtml(h3 ? h3.text : "").trim();
            if (!title) continue;
            seen[link] = true;
            // 검색 카드에는 "TV 2007 . 720/720" 처럼 연도가 있음 (같은 제목 구별용)
            const p = first(item, ".vod-item-info p");
            const year = ((p ? p.text : "").match(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/) || [null, ""])[1];
            if (year && !title.includes(`(${year})`)) title = `${title} (${year})`;
            const img = first(item, ".img-wrapper");
            list.push({ name: title, imageUrl: img ? this.abs(img.attr("data-original")) : "", link });
        }
        // 쪽 번호 링크 중 지금 쪽 + 1 이 있으면 다음 쪽이 있음
        const cur = Number((/\/page\/(\d+)\//.exec(path) || [null, "1"])[1]);
        // 사이트는 마지막 쪽에도 다음 쪽 링크를 남김(연도 2026·극장판: 2쪽 7개인데 3쪽 링크) → 쪽이 거의 차 있을 때만 다음 쪽
        const hasNextPage = new RegExp(`/page/${cur + 1}/`).test(html) && list.length >= 20;
        return { list, hasNextPage };
    }

    async listPage(idx, page) {
        const path = this.listPath(idx, page);
        return this.parseCards(await this.get(path), path);
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return this.listPage(ruleRead("linkani", true, RULE_SIZES) || DEFAULT_POPULAR, page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead("linkani", false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        const pasted = /(?:linkani\d*|linkkf\d*)\.[a-z]{2,6}\/(?:ani|watch)\/(\d+)/.exec(query);
        if (pasted) {
            const path = `/ani/${pasted[1]}/`;
            const d = await this.getDetail(path);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: path }], hasNextPage: false };
        }
        if (query) {
            const path = `/view/${page > 1 ? `page/${page}/` : ""}?wd=${encodeURIComponent(query)}`;
            return this.parseCards(await this.get(path), path);
        }
        const idx = [0, 0, 0, 0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), RULE_SIZES[k] - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (rule) ruleApply("linkani", rule, idx);
        return this.listPage(idx, page);
    }

    // ================= 작품 정보 · 회차 =================
    async getDetail(url) {
        const path = this.pathOf(url) || url;
        const html = await this.get(path);
        const doc = new Document(html);
        const meta = {};
        for (const li of doc.select(".detail-info-desc li")) {
            const span = first(li, "span");
            if (!span) continue;
            const k = span.text.replace(/[：:]/g, "").trim();
            const links = li.select("a").map((a) => decodeHtml(a.text).trim()).filter((x) => x);
            meta[k] = links.length ? links.join(", ") : decodeHtml(li.text.replace(span.text, "")).trim();
        }
        const h1 = first(doc, "h1.detail-info-title");
        const t = decodeHtml(h1 ? h1.text : "").trim();
        const year = ((meta["년"] || "").match(/(?:19|20)\d{2}/) || [""])[0];
        const type = meta["분류"] || "";
        // 사이트에 방영 중 여부가 없어 연도만 붙임 (같은 제목 구별용)
        const title = t && year && !t.includes(`(${year})`) ? `${t} (${year})` : t;
        const img = first(doc, ".detail-img [data-original]");
        const og = /<meta property="og:image" content="([^"]+)"/.exec(html);
        const descM = /<meta name="description" content="([^"]*)"/.exec(html);
        const story = decodeHtml(descM ? descM[1] : "").trim().replace(`${t} 다시보기.`, "").trim();
        const info = [
            type ? `분류: ${type}` : "",
            year ? `연도: ${year}` : "",
            meta["총화수"] ? `총화수: ${meta["총화수"]}` : "",
            "자막: 한국어",
        ].filter((x) => x).join("\n");
        // 회차 (사이트는 최신이 위). 회차 번호는 주소의 kN, 이름은 "1179화" 이거나 회차 제목
        const episodes = [];
        const seen = {};
        for (const a of doc.select(".episode-box a")) {
            const href = String(a.attr("href") || "").replace(HOST_RE, "");
            const m = /^\/watch\/\d+\/[^/]+\/([^/]+)\/?$/.exec(href);
            if (!m || seen[href]) continue;
            seen[href] = true;
            const num = (/\d+(?:\.\d+)?/.exec(m[1]) || [m[1]])[0];
            const label = decodeHtml(a.text).trim();
            const name = !label || label === num || label === `${num}화` ? `${num}화` : `${num}화 ${label}`;
            episodes.push({ name, url: href, dateUpload: null });
        }
        // 극장판·OVA 처럼 회차가 하나뿐이면 다른 확장과 같게 "본편"(망가요미는 앞에 번호 "1. ") — 상태도 완결
        const movie = /극장판|movie|영화/i.test(type) || /^\[?극장판/.test(t);
        if (movie && episodes.length === 1) episodes[0].name = "1. 본편";
        return {
            name: title,
            imageUrl: img ? this.abs(img.attr("data-original")) : og ? og[1] : "",
            link: this.getBaseUrl() + path,
            description: [story, info].filter((x) => x).join("\n\n"),
            // 제작사는 사이트가 모든 작품에 "OLM" 을 붙여(가짜 값) 쓰지 않음
            author: "",
            status: movie ? 1 : 5,
            genre: (meta["장르"] || "").split(",").map((x) => x.trim()).filter((x) => x),
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        const path = String(url || "").replace(HOST_RE, "");
        const html = await this.get(path);
        const player = playerData(html);
        if (!player) throw new Error("이 회차에는 재생 정보가 없습니다");
        const main = String(player.actual_url || player.url || "").trim();
        if (!/^https?:\/\//.test(main)) throw new Error("영상 주소를 찾지 못했습니다");
        const sub = String(player.subtitle_url || "").trim();
        const subtitles = /^https?:\/\//.test(sub) ? [{ file: sub, label: "한국어" }] : [];
        const base = this.getBaseUrl();
        const h = { "User-Agent": UA, "Referer": `${base}/`, "Origin": base };
        const label = subtitles.length ? `${LABEL} 자막` : LABEL;
        const list = await hlsExpand(this.client, main, label, h);
        return qualitySort("linkani_quality", list.map((v) => Object.assign(v, { subtitles, audios: [] })));
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${host}` },
            { type_name: "HeaderFilter", name: "🔗 애니라이프와 같은 자료(쌍둥이) — 작품·순서·영상이 같음, 한쪽이 막히면 다른 쪽에서 같은 작품을 찾으면 됨" },
            ...notesFilters("linkani"),
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), [{ type_name: "HeaderFilter", name: "오늘 인기 순위는 다른 조건 없이 순위만 보여 줌. 요일을 고르면 장르 대신 요일" }],
        ruleFilters("linkani", RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: "linkani_domain",
            editTextPreference: {
                title: "링크애니 주소 직접 지정 (선택)",
                summary: `비워 두면 기본 주소(${DEFAULT_BASE_URL})를 사용합니다.`,
                value: "",
                dialogTitle: "링크애니 주소",
                dialogMessage: "https:// 로 시작하는 링크애니 주소 (예: https://linkani.tv)",
            },
        }, qualityPreference("linkani_quality")];
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
