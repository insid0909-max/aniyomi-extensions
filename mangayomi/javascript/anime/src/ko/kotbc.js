const mangayomiSources = [{
    "name": "코티비씨",
    "lang": "ko",
    "baseUrl": "https://k05.kotbc2.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.20",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/kotbc.js"
}];

// 코티비씨(k05.kotbc2.com, 같은 사이트 코무비 k05.kormovie.com) 영화·드라마·예능시사·해외드라마 (2026-10-30, 사용자가 보내 준 화면 글로 구조 확인 — 해외에서는 사이트가 막혀 직접 못 봄)
// - Laravel + Inertia 사이트: 화면 안 <script data-page="app" type="application/json"> 에 화면 데이터가 통째로 있음
//   첫 화면 props.sections[{label, href, items[작품]}], 작품 {title, slug, thumbnail(/storage/…), category, broadcaster, cast_names,
//   country, air_schedule, runtime, episode_total, published_at, completed_at, card_meta{kind(movie|series),left,right},
//   metadata.last_episode_at, tags[{name:{ko}}], latest_episode}
// - 작품 화면 /{slug} (component contents/List): props.comic(작품) + props.episodes(쪽 나눔 per_page 100, ?page=N)
//   회차 {title("47화"), sort, published_at, slug, body{url:"https://nnmo0oi1.com/video/{영상ID}", iframe}}
// - 분류 /영화 · /드라마 · /예능시사 · /해외드라마 (?page=N), 필터는 첫 화면 주소 /?sort=…&types[0]=…&genres[0]=…&years[0]=… (props.comics)
// - 영상 플레이어 nnmo0oi1.com/video/{ID} = 애니24 와 같은 종류 → 애니24 에서 재생 확인된 방법(POST getVideo → securedLink) 그대로
const DEFAULT_BASE_URL = "https://k05.kotbc2.com";
// 같은 사이트의 두 이름: 코티비씨(kotbc2.com) · 코무비(kormovie.com) — 화면·작품·주소 모양이 같음 (2026-10-30 사용자 확인)
const DOMAIN_RE = /^https:\/\/(?:[a-z]\d+\.)?(?:kotbc\d*|kormovie)\.[a-z]{2,6}$/;
const LABEL = "코티비씨";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
// 주소 안내 사이트 (사이트 화면의 "주소안내(코사이트)")
const GUIDE_URL = "https://korsite.net/";

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함). 사이트 필터 주소(2026-10-30 확인):
// /?keyword=검색어&sort=update-desc&types[0]=영화&types[1]=… (&page=N) — 장르·연도는 같은 모양(genres[]·years[], 첫 화면 filterOptions 이름)으로 추정
// 종류: [이름, 사이트 값, 분류 화면 주소] — 다른 필터를 안 쓰면 원래 분류 화면(/드라마 등)을 그대로 씀
const TYPES = [["전체", "", ""], ["국내드라마", "국내드라마", "/드라마"], ["예능시사", "예능시사", "/예능시사"], ["영화", "영화", "/영화"], ["해외드라마", "해외드라마", "/해외드라마"]];
const GENRES = ["전체",
    "액션", "스릴러", "범죄", "공포", "미스터리", "재난", "서스펜스",
    "드라마", "코미디", "로맨스", "멜로", "가족", "휴먼", "힐링", "복수", "틴에이저", "연애", "성장", "일상", "청춘", "로맨틱 코미디",
    "판타지", "SF", "어드벤처", "전쟁", "시대극", "무협", "서사", "역사", "사극", "서부",
    "음악", "스포츠", "음식", "법정", "오피스", "의학", "요리",
    "애니메이션", "다큐멘터리", "뮤지컬", "전기", "시트콤", "단편", "공연",
    "예능", "시사", "리얼리티", "버라이어티", "교양", "토크", "여행", "서바이벌", "시상식",
];
const YEARS = [["전체", ""]].concat(
    ["2027", "2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018", "2017", "2016", "2015", "2014", "2013",
        "2012", "2011", "2010"].map((y) => [y, y]),
    [["2005~09", "2005-2009"], ["2000~04", "2000-2004"], ["1990년대", "1990-1999"], ["1980년대", "1980-1989"], ["1979년 이전", "0-1979"]],
);
// 정렬: update-desc 는 확인, 나머지 값은 같은 모양으로 추정
const SORTS = [["업데이트 최신순", "update-desc"], ["업데이트 오래된순", "update-asc"], ["공개일 최신순", "published-desc"],
    ["공개일 오래된순", "published-asc"], ["별점 높은순", "rating-desc"], ["제목 가나다순", "title-asc"]];
const FILTER_DEFS = [
    ["종류", "type", TYPES.map((t) => t[0])],
    ["장르", "genre", GENRES],
    ["연도", "year", YEARS.map((y) => y[0])],
    ["정렬", "sort", SORTS.map((x) => x[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [1, 0, 0, 0];
const DEFAULT_LATEST = [2, 0, 0, 0];

function ruleText(i) {
    return [TYPES[i[0]][0], i[1] > 0 ? GENRES[i[1]] : null, i[2] > 0 ? YEARS[i[2]][0] : null, i[3] > 0 ? SORTS[i[3]][0] : null]
        .filter((x) => x).join(" · ");
}

/** 사이트 필터 주소 조각 (검색어·쪽 번호 제외) */
function filterQuery(idx) {
    const q = [`sort=${SORTS[idx[3]][1]}`];
    if (idx[0] > 0) q.push(`types%5B0%5D=${encodeURIComponent(TYPES[idx[0]][1])}`);
    if (idx[1] > 0) q.push(`genres%5B0%5D=${encodeURIComponent(GENRES[idx[1]])}`);
    if (idx[2] > 0) q.push(`years%5B0%5D=${encodeURIComponent(YEARS[idx[2]][1])}`);
    return q.join("&");
}

let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 300 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

/** "2026-10-29T12:28:23.000000Z" · "2026-10-29T21:28:23+09:00" → ms */
// 날짜 글자 → 밀리초. 망가요미 안의 자바스크립트는 "2026-11-03 21:00:00"(띄어쓰기) 같은 모양을 Date.parse 로 못 읽을 수 있어 직접 읽음.
// 시간대가 없으면 한국 시간, 숫자면 유닉스 시각(초·밀리초)
function timeMs(s) {
    if (s === null || s === undefined || s === "") return 0;
    const str = String(s).trim();
    if (/^\d{9,13}$/.test(str)) {
        const n = Number(str);
        return n < 1e12 ? n * 1000 : n;
    }
    const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?/i.exec(str);
    if (!m) {
        const t = Date.parse(str);
        return isNaN(t) ? 0 : t;
    }
    let t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    const z = m[7];
    if (!z) {
        t -= 9 * 3600000;
    } else if (z.toUpperCase() !== "Z") {
        const o = /([+-])(\d{2}):?(\d{2})/.exec(z);
        const off = (Number(o[2]) * 60 + Number(o[3])) * 60000;
        t -= o[1] === "+" ? off : -off;
    }
    return isNaN(t) ? 0 : t;
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

function yearOf(ms) {
    return ms ? new Date(ms + 9 * 3600000).getUTCFullYear() : 0;
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch (e) {
        return s;
    }
}

function decodeHtml(s) {
    return String(s || "").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

/** 화면 안의 Inertia 화면 데이터 (data-page) */
// 글자 종류(charset)가 없는 JSON 응답을 망가요미가 Latin-1 로 넘길 때 UTF-8 로 되돌림 (북코 fixUtf8 과 같음)
function kotbcUtf8(s) {
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
        let ok = n > 0 && i + n < s.length + 1;
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

function pageData(html) {
    const m = /<script[^>]*data-page=["']app["'][^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (m) {
        try {
            return JSON.parse(m[1]);
        } catch (e) {
            // 아래 방법
        }
    }
    const a = /data-page=(["'])([\s\S]*?)\1/.exec(html);
    if (a && a[2].trim().startsWith("{")) {
        try {
            return JSON.parse(decodeHtml(a[2]));
        } catch (e) {
            return null;
        }
    }
    return null;
}

/** 작품처럼 보이는 것 (회차·댓글 제외) */
function isSeries(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    if (!o.title || !o.slug || !o.thumbnail) return false;
    if (o.series_id !== undefined || o.body) return false;
    return !o.content || o.content.role === "series";
}

/** 화면 데이터에서 작품을 두루 모음 (나온 순서, 겹치지 않게) + 다음 쪽이 있는지 */
function collectSeries(props) {
    const out = [];
    const seen = {};
    let hasNext = false;
    const skip = { popular: 1, recentComments: 1, banner: 1, translations: 1, setting: 1 };
    const walk = (x, depth) => {
        if (!x || typeof x !== "object" || depth > 7) return;
        if (Array.isArray(x)) {
            for (const y of x) walk(y, depth + 1);
            return;
        }
        if (isSeries(x)) {
            if (!seen[x.slug]) {
                seen[x.slug] = true;
                out.push(x);
            }
            return;
        }
        if (Array.isArray(x.data) && (x.current_page !== undefined || x.next_page_url !== undefined)) {
            if (x.next_page_url || (x.last_page && x.current_page < x.last_page)) hasNext = true;
        }
        for (const k in x) if (!(depth === 0 && skip[k])) walk(x[k], depth + 1);
    };
    walk(props || {}, 0);
    return { items: out, hasNext };
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

// 주소 바뀜 대응 설정: 사이트 주소 모양, 진짜 사이트 표시 글자, User-Agent, 직접 넣은 주소 설정 키
const ADDR_HOST = /^(?:[a-z]\d+\.)?(?:kotbc\d*|kormovie)\.[a-z]{2,6}$/;
// 두 이름 모두 화면 데이터에 있는 글자 (자매 사이트 목록)
const ADDR_MARK = "sister_sites";
const ADDR_UA = UA;
const ADDR_PREF = "kotbc_domain";

// ---------- 주소가 바뀐 것 같을 때 · 붙여 넣은 새 주소 (애니·웹툰 망가요미 파일 같은 코드, 위 ADDR_* 만 다름) ----------
const ADDR_HELP = "주소가 바뀐 것 같아요. 브라우저에서 사이트가 열리면 그 주소를 검색창에 붙여 넣어 주세요. 브라우저에서는 열리는데 앱에서만 안 되면: 잠시 뒤 다시 · 앱 완전히 껐다 켜기 · 유니콘 등 DNS 앱을 쓰면 DNS 를 Google 로.";

function addrCurrent(ext) {
    try {
        return String("base" in ext ? ext.base : ext.getBaseUrl());
    } catch (e) {
        return "";
    }
}

// 그 주소가 진짜 사이트인지 (첫 화면에 사이트 표시 글자가 있는지)
async function addrIsSite(ext, origin) {
    try {
        const r = await ext.client.get(origin + "/", { "User-Agent": ADDR_UA });
        return r.statusCode === 200 && String(r.body || "").toLowerCase().includes(ADDR_MARK.toLowerCase());
    } catch (e) {
        return false;
    }
}

// 검색창에 붙여 넣은 사이트 주소(https:// 없어도 됨)가 지금 주소와 다르고 진짜 사이트면 직접 넣은 주소로 바로 씀 → 바뀐 주소(없으면 null)
async function addrAdopt(ext, query) {
    const m = /^(?:https?:\/\/)?([^/?#\s]+)(?:[/?#]\S*)?$/.exec(String(query || "").trim());
    if (!m || !ADDR_HOST.test(m[1].toLowerCase())) return null;
    const origin = "https://" + m[1].toLowerCase();
    const plain = (u) => String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    if (plain(origin) === plain(addrCurrent(ext))) return null;
    if (!(await addrIsSite(ext, origin))) return null;
    try {
        new SharedPreferences().setString(ADDR_PREF, origin);
    } catch (e) {
        return null;
    }
    return origin;
}

// 인기·최신 첫 쪽이 오류이거나 비었는데 지금 주소가 사이트가 아니면(끊김·빈 페이지·404) 새 주소를 찾아 다시 불러옴,
// 못 찾으면 붙여 넣기 안내 (지금 주소가 진짜 사이트면 원래 결과·오류 그대로)
async function addrGuard(ext, page, fn) {
    let r = null;
    let err = null;
    try {
        r = await fn();
    } catch (e) {
        err = e;
    }
    if (page !== 1 || (r && r.list && r.list.length) || !ext.autoOn()) {
        if (err) throw err;
        return r;
    }
    const base = addrCurrent(ext);
    if (await addrIsSite(ext, base)) {
        if (err) throw err;
        return r;
    }
    const found = await ext.discover(base);
    if (found) return await fn();
    throw new Error(ADDR_HELP + (err ? ` [${(err && err.message) || err}]` : ""));
}


// 저장소 주소 목록 파일(domains.json, 2026-11-03): 확장이 스스로 새 주소를 못 찾을 때를 대비해 저장소에 적어 둔 지금 주소.
// 주소 찾기 때 먼저 확인하고, 진짜 사이트일 때만 씀
const DOMAIN_LIST_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/domains.json";
async function listedDomain(client, key) {
    try {
        const r = await client.get(DOMAIN_LIST_URL + "?t=" + Math.floor(Date.now() / 60000), { "Cache-Control": "no-cache" });
        if (Number(r.statusCode) !== 200) return "";
        const u = String((((JSON.parse(String(r.body || "{}")).domains || {})[key]) || {}).baseUrl || "").trim().replace(/\/+$/, "");
        return /^https:\/\/[A-Za-z0-9.-]+$/.test(u) ? u.toLowerCase() : "";
    } catch (e) {
        return "";
    }
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    // ================= 주소 =================
    pref(key) {
        try {
            return String(new SharedPreferences().get(key) || "").trim();
        } catch (e) {
            return "";
        }
    }

    saved(key) {
        try {
            return String(new SharedPreferences().getString(key, "") || "").trim();
        } catch (e) {
            return "";
        }
    }

    // 직접 넣은 주소 > (번호가 더 큰) 자동으로 찾은 주소 > 기본 주소
    getBaseUrl() {
        const manual = this.pref("kotbc_domain").replace(/\/+$/, "");
        const auto = this.saved("kotbc_auto_domain");
        const num = (u) => Number((/(\d+)\.(?:kotbc|kormovie)(\d*)/.exec(u) || [0, 0, 0]).slice(1).reverse().join("")) || 0;
        if (DOMAIN_RE.test(manual)) {
            // 번호 비교는 같은 이름끼리만 (kotbc2 와 kormovie 는 번호 체계가 달라 비교하지 않음)
            const brand = (u) => (/kormovie/.test(u) ? "m" : "t");
            if (this.autoOn() && DOMAIN_RE.test(auto) && auto !== manual && brand(auto) === brand(manual) && num(auto) > num(manual)) {
                try {
                    new SharedPreferences().setString("kotbc_domain", auto);
                } catch (e) {
                    // 그대로
                }
                return auto;
            }
            return manual;
        }
        return DOMAIN_RE.test(auto) ? auto : DEFAULT_BASE_URL;
    }

    autoOn() {
        try {
            const v = new SharedPreferences().get("kotbc_auto");
            return v !== false && v !== "false";
        } catch (e) {
            return true;
        }
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    /** 사이트 주소가 바뀌었을 때: 안내 사이트에 적힌 주소 → 앞 글자 번호(k05→k06…) · 뒤 번호(kotbc2→kotbc3…) */
    async discover(current) {
        const tries = [];
        // 저장소 주소 목록 파일에 적힌 주소 먼저 (아래에서 진짜 사이트인지 확인)
        const listed = await listedDomain(this.client, "kotbc");
        if (listed && DOMAIN_RE.test(listed)) tries.push(listed);
        try {
            const r = await this.client.get(GUIDE_URL, { "User-Agent": UA });
            const re = /https?:\/\/((?:[a-z]\d+\.)?(?:kotbc\d*|kormovie)\.[a-z]{2,6})/gi;
            let m;
            while ((m = re.exec(String(r.body || "")))) tries.push("https://" + m[1].toLowerCase());
        } catch (e) {
            // 다음 방법
        }
        const m = /^https:\/\/(?:([a-z])(\d+)\.)?kotbc(\d*)\.([a-z]{2,6})$/.exec(current);
        if (m) {
            const pad = (n, w) => String(n).padStart(w, "0");
            const sub = m[1] ? Number(m[2]) : 0;
            const main = Number(m[3] || 0);
            for (let d = 1; d <= 4; d++) {
                if (m[1]) tries.push(`https://${m[1]}${pad(sub + d, m[2].length)}.kotbc${m[3]}.${m[4]}`);
                tries.push(`https://${m[1] ? m[1] + m[2] + "." : ""}kotbc${main + d}.${m[4]}`);
                if (m[1]) tries.push(`https://${m[1]}${pad(sub + d, m[2].length)}.kotbc${main + d}.${m[4]}`);
            }
        }
        // 다른 이름(코무비 kormovie.com)의 같은 번호·다음 번호
        const k = /^https:\/\/([a-z])(\d+)\.(?:kotbc\d*|kormovie)\./.exec(current);
        if (k) {
            for (let d = 0; d <= 4; d++) tries.push(`https://${k[1]}${String(Number(k[2]) + d).padStart(k[2].length, "0")}.kormovie.com`);
        }
        const seen = {};
        for (const t of tries) {
            if (seen[t] || t === current) continue;
            seen[t] = true;
            if (await addrIsSite(this, t)) {
                try {
                    new SharedPreferences().setString("kotbc_auto_domain", t);
                } catch (e) {
                    // 그대로
                }
                return t;
            }
        }
        return null;
    }

    async getHtml(path) {
        const base = this.getBaseUrl();
        const url = /^https?:\/\//.test(path) ? path : base + path;
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, this.getHeaders());
            } catch (e) {
                if (attempt === 1) throw new Error(`${LABEL} 접속 실패: ${String((e && e.message) || e).substring(0, 80)}`);
                await new Promise((r) => setTimeout(r, 700));
            }
        }
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 (HTTP ${res.statusCode})`);
        return String(res.body || "");
    }

    /** 화면 데이터(props). 없으면 오류에 화면 모양을 조금 보여 줌 */
    async props(path) {
        const html = await this.getHtml(path);
        const data = pageData(html);
        if (!data || !data.props) {
            const t = (/<title[^>]*>([^<]*)/.exec(html) || [null, ""])[1].trim();
            throw new Error(`화면 데이터를 찾지 못했어요 [${t || html.replace(/\s+/g, " ").substring(0, 60)}]`);
        }
        data.props._component = data.component || "";
        data.props._version = data.version || "";
        return data.props;
    }

    imageOf(o) {
        const t = String((o && (o.thumbnail || o.background)) || "");
        if (!t) return "";
        if (/^https?:\/\//.test(t)) return t;
        return `${this.getBaseUrl()}/storage/${t.replace(/^\/?(storage\/)?/, "")}`;
    }

    /** 사이트 주소 → "/작품" (회차 주소면 작품 부분만) */
    pathOf(href) {
        let p = String(href || "").trim();
        const m = /^https?:\/\/[^/]+(\/[^?#]*)/.exec(p);
        if (m) {
            const host = (/^https?:\/\/([^/]+)/.exec(p) || [])[1] || "";
            if (!ADDR_HOST.test(host.toLowerCase())) return null;
            p = m[1];
        }
        p = safeDecode(p.split(/[?#]/)[0]);
        const parts = p.split("/").filter(Boolean);
        if (!parts.length) return null;
        return "/" + parts[0];
    }

    // ================= 목록 =================
    cardOf(o) {
        let name = String(o.title || "").trim();
        const kind = o.card_meta && o.card_meta.kind;
        const le = o.latest_episode || {};
        const last = timeMs(o.metadata && o.metadata.last_episode_at) || timeMs(o.last_episode_at) || timeMs(le.published_at || le.created_at);
        const year = yearOf(timeMs(o.published_at));
        if (kind === "movie" || o.completed_at) {
            if (year && !name.includes(`(${year})`)) name = `${name} (${year})`;
        } else if (last) {
            name = `${name} · ${mmdd(last)}`;
        }
        return { name, imageUrl: this.imageOf(o), link: "/" + o.slug };
    }

    listPath(idx, page) {
        // 종류만 고른 기본 정렬이면 원래 분류 화면 (휴대폰에서 확인된 주소), 아니면 사이트 필터 주소
        if (idx[0] > 0 && !idx[1] && !idx[2] && !idx[3]) return encodeURI(TYPES[idx[0]][2]) + (page > 1 ? `?page=${page}` : "");
        return `/?${filterQuery(idx)}` + (page > 1 ? `&page=${page}` : "");
    }

    async listPage(idx, page) {
        const props = await this.props(this.listPath(idx, page));
        const got = collectSeries(props);
        if (!got.items.length && page === 1) {
            throw new Error(`작품을 찾지 못했어요 [${props._component} · ${Object.keys(props).filter((k) => k !== "_component").join(",").substring(0, 80)}]`);
        }
        return { list: got.items.map((o) => this.cardOf(o)), hasNextPage: got.hasNext };
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return addrGuard(this, page, () => this.listPage(ruleRead("kotbc", true, RULE_SIZES) || DEFAULT_POPULAR, page));
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return addrGuard(this, page, () => this.listPage(ruleRead("kotbc", false, RULE_SIZES) || DEFAULT_LATEST, page));
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 새 사이트 주소를 붙여 넣으면 그 주소로 바꾸고 인기 목록
        const adopted = await addrAdopt(this, query);
        if (adopted) {
            const path = /^(?:https?:\/\/)?[^/]+(\/[^?#\s]+)/.exec(query);
            if (!path || !this.pathOf(adopted + path[1])) return this.getPopular(1);
        }
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        if (/(?:kotbc\d*|kormovie)\.[a-z]{2,6}\/\S+/i.test(query)) {
            const path = this.pathOf(/^https?:\/\//.test(query) ? query : "https://" + query);
            if (path) {
                const d = await this.getDetail(path);
                return { list: [{ name: d.name, imageUrl: d.imageUrl, link: path }], hasNextPage: false };
            }
        }
        const idx = [0, 0, 0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), RULE_SIZES[k] - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (query) return this.searchSite(query, page, idx);
        if (rule) ruleApply("kotbc", rule, idx);
        return this.listPage(idx, page);
    }

    /** 검색: 사이트 검색은 /?keyword=검색어&page=N (props.comics, 2026-10-30 확인). 안 되면 다른 흔한 모양도 차례로 시도, 된 모양은 기억 */
    async searchSite(query, page, idx) {
        const q = encodeURIComponent(query);
        const pg = page > 1 ? `&page=${page}` : "";
        const fq = idx && idx.some((v) => v > 0) ? "&" + filterQuery(idx) : "";
        const forms = [`/?keyword=${q}${fq}${pg}`, `/search?q=${q}${pg}`, `/search?keyword=${q}${pg}`, `/?q=${q}${pg}`, `/?search=${q}${pg}`, `/api/search?q=${q}`];
        const savedForm = Number(this.saved("kotbc_search_form2"));
        const order = forms.map((_, i) => i).sort((a, b) => (a === savedForm ? -1 : b === savedForm ? 1 : a - b));
        const words = query.replace(/\s+/g, "").toLowerCase();
        const fails = [];
        for (const i of order) {
            let body;
            try {
                await siteWait();
                const res = await this.client.get(this.getBaseUrl() + forms[i], Object.assign({ "Accept": "text/html,application/json" }, this.getHeaders()));
                if (res.statusCode >= 400) {
                    fails.push(`${i + 1}:${res.statusCode}`);
                    continue;
                }
                body = String(res.body || "");
            } catch (e) {
                fails.push(`${i + 1}:오류`);
                continue;
            }
            let props = null;
            if (body.trim().startsWith("{") || body.trim().startsWith("[")) {
                try {
                    props = JSON.parse(body);
                } catch (e) {
                    props = null;
                }
            } else {
                const d = pageData(body);
                props = d && d.props;
            }
            const got = collectSeries(props);
            // 검색어와 관계없는 첫 화면 목록이면 맞는 작품만
            const hits = got.items.filter((o) => String(o.title || "").replace(/\s+/g, "").toLowerCase().includes(words));
            if (hits.length) {
                try {
                    new SharedPreferences().setString("kotbc_search_form2", String(i));
                } catch (e) {
                    // 그대로
                }
                return { list: hits.map((o) => this.cardOf(o)), hasNextPage: got.hasNext && hits.length === got.items.length };
            }
            // 사이트 화면이 제대로 왔는데 맞는 작품이 없으면 "검색 결과 없음"(오류 화면 대신 빈 목록, 2026-11-06 "폴2").
            // 확인된 검색 주소(/?keyword=)가 응답했으면 다른 옛 주소는 더 시험하지 않음
            if (props && i === 0) return { list: [], hasNextPage: false };
            fails.push(`${i + 1}:0`);
        }
        if (page > 1) return { list: [], hasNextPage: false };
        // 어느 주소든 사이트가 응답했으면 결과 없음, 모두 연결 실패·오류일 때만 오류
        if (fails.some((f) => / *:0$/.test(f))) return { list: [], hasNextPage: false };
        throw new Error(`검색 중 사이트에 연결되지 않았어요 [${fails.join(" ")}]`);
    }

    // ================= 작품 정보 · 회차 =================
    async getDetail(url) {
        const path = this.pathOf(url) || url;
        const props = await this.props(encodeURI(path));
        const o = props.comic || props.series || collectSeries(props).items[0];
        if (!o) throw new Error(`작품 정보를 찾지 못했어요 [${props._component}]`);
        const raw = [];
        // 회차: 재생 주소(body)가 없는 회차도 회차 주소(slug)가 있으면 넣음 — 재생 때 회차 화면에서 주소를 다시 찾음
        // (2026-11-04 엄마가 미쳤어요 0개: 회차 목록에 body 가 없는 작품이 있는 듯). episodes 가 배열 그대로인 경우도
        const epList = (x) => (Array.isArray(x) ? x : x && Array.isArray(x.data) ? x.data : []);
        const add = (list) => {
            for (const e of list || []) if (e && (e.body || e.slug) && (e.title !== undefined || e.sort !== undefined)) raw.push(e);
        };
        // 2026-11-05 같은 사이트 시스템(북코)이 바뀜: episodes 가 [id, "47화", 회차slug, "2026-05-10"] 짧은 목록(앞 10개),
        // 전체는 화면처럼 Inertia 부분 새로고침(only=episodesAll)으로 받음 → props.episodesAll.rows (같은 모양). 코티비씨도 같을 것으로 보고 대비
        if (Array.isArray(props.episodes) && props.episodes.length && Array.isArray(props.episodes[0])) {
            let rows = props.episodes;
            if ((Number(props.episodesTotal) || 0) > rows.length) {
                try {
                    const h = Object.assign(this.getHeaders(), {
                        "X-Inertia": "true",
                        "X-Inertia-Partial-Component": props._component || "contents/List",
                        "X-Inertia-Partial-Data": "episodesAll",
                        "X-Requested-With": "XMLHttpRequest",
                        "Accept": "text/html, application/xhtml+xml",
                    });
                    if (props._version) h["X-Inertia-Version"] = String(props._version);
                    await siteWait();
                    const r = await this.client.get(this.getBaseUrl() + encodeURI(path), h);
                    const all = ((JSON.parse(kotbcUtf8(r.body)).props || {}).episodesAll || {}).rows;
                    if (Array.isArray(all) && all.length > rows.length) rows = all;
                } catch (e) {
                    // 앞 10개만
                }
            }
            const n = rows.length;
            props.episodes = rows.filter((r) => Array.isArray(r) && r[2]).map((r, i) => {
                const num = /\d+(?:\.\d+)?/.exec(String(r[1] || ""));
                return { id: r[0], title: String(r[1] || ""), slug: r[2], published_at: r[3] || null, sort: num ? Number(num[0]) : n - i };
            });
        }
        add(epList(props.episodes));
        if (!raw.length) add(epList(o.episodes));
        // 회차는 100개씩 나뉨 → 나머지 쪽도 받음
        const lastPage = Math.min(Number(props.episodes && props.episodes.last_page) || 1, 30);
        for (let p = 2; p <= lastPage; p++) {
            try {
                const more = await this.props(`${encodeURI(path)}?page=${p}`);
                add(epList(more.episodes));
            } catch (e) {
                break;
            }
        }
        if (!raw.length && !(o.card_meta && o.card_meta.kind === "movie")) {
            const ep = props.episodes;
            const shape = ep ? (Array.isArray(ep) ? `배열 ${ep.length}` : `${Object.keys(ep).slice(0, 8).join(",")} · data ${Array.isArray(ep.data) ? ep.data.length : "-"}`) : "없음";
            const first = ep && (Array.isArray(ep) ? ep[0] : ep.data && ep.data[0]);
            throw new Error(`회차를 찾지 못했어요 [${props._component} · episodes ${shape}${first ? " · 첫 회차 " + Object.keys(first).slice(0, 10).join(",") : ""} · ${Object.keys(props).filter((k) => k !== "_component").join(",").substring(0, 80)}]`);
        }
        const seen = {};
        const eps = raw.filter((e) => {
            const k = e.slug || e.id;
            if (seen[k]) return false;
            seen[k] = true;
            return true;
        });
        // 최신 회차가 위 (회차 번호 sort → 올린 시각 순)
        eps.sort((a, b) => (Number(b.sort) || 0) - (Number(a.sort) || 0) || timeMs(b.published_at) - timeMs(a.published_at));
        const kind = o.card_meta && o.card_meta.kind;
        const movie = kind === "movie";
        const episodes = eps.map((e) => {
            const t = String(e.title || "").trim();
            const at = timeMs(e.published_at || e.created_at);
            // 회차 이름은 회차 번호로 시작 (망가요미가 맨 앞 숫자를 회차로 읽음)
            let name = /^\d/.test(t) ? t : `${Number(e.sort) || 1}화${movie || t === o.title ? "" : " " + t}`;
            if (at) name += ` (${mmdd(at)})`;
            const player = e.body && e.body.url ? String(e.body.url) : "";
            return {
                name,
                url: `${path}/${e.slug || ""}#p=${encodeURIComponent(player)}`,
                dateUpload: at ? String(at) : null,
            };
        });
        const last = Math.max(0, ...eps.map((e) => timeMs(e.published_at)));
        const done = movie || !!o.completed_at || eps.some((e) => /완결/.test(String(e.title || "")));
        const year = yearOf(timeMs(o.published_at));
        let title = String(o.title || "").trim();
        if (done) {
            if (year && !title.includes(`(${year})`)) title = `${title} (${year})`;
        } else if (last) {
            title = `${title} · ${mmdd(last)}`;
        }
        const tags = (o.tags || []).map((t) => (t && t.name && (t.name.ko || t.name)) || "").filter((x) => typeof x === "string" && x);
        const info = [
            ["분류", o.category], ["방송사", o.broadcaster], ["방송", o.air_schedule], ["나라", o.country], ["감독", o.director],
            ["출연", o.cast_names], ["상영 시간", o.runtime ? `${o.runtime}분` : ""], ["전체", o.episode_total ? `${o.episode_total}화` : ""],
            ["첫 방송", o.published_at ? fullDate(timeMs(o.published_at)) : ""],
        ].filter((x) => x[1]).map((x) => `${x[0]}: ${x[1]}`).join("\n");
        return {
            name: title,
            imageUrl: this.imageOf(o),
            link: this.getBaseUrl() + encodeURI(path),
            description: [
                !done && last ? `방영 중 · 최근 방영: ${fullDate(last)}` : "",
                String(o.description || "").trim(),
                info,
            ].filter((x) => x).join("\n\n"),
            author: o.broadcaster || "",
            status: done ? 1 : 0,
            genre: tags.length ? tags : String(o.tags_string || "").split(",").map((x) => x.trim()).filter((x) => x),
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        this.diag = [];
        const hash = /#p=([^#]*)/.exec(url);
        let player = hash ? safeDecode(hash[1]) : "";
        const pagePath = url.split("#")[0];
        const pageUrl = this.getBaseUrl() + encodeURI(pagePath);
        // 회차 화면에서 다시 확인 (플레이어 주소가 바뀌었을 수 있음)
        try {
            const props = await this.props(encodeURI(pagePath));
            const u = props.playing && props.playing.body && props.playing.body.url;
            if (u) player = String(u);
        } catch (e) {
            if (!player) throw e;
        }
        if (!/^https?:\/\//.test(player)) throw new Error("이 회차에는 재생 화면이 없습니다");
        // 영상 파일 주소가 바로 있으면 그대로
        if (/\.(m3u8|mp4)(\?|$)/i.test(player)) {
            return qualitySort("kotbc_quality", await hlsExpand(this.client, player, LABEL, { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` }));
        }
        const origin = (/^(https?:\/\/[^/]+)/.exec(player) || [null, ""])[1];
        // 1) 애니24에서 망가요미 재생이 확인된 방법 (같은 종류 플레이어)
        let list = await this.dcVideos(player, origin, LABEL);
        if (!list.length) {
            // 2) 안 되면: 플레이어 POST → 플레이어 화면 → 웹뷰
            const fire = (await this.firePlayer(player, pageUrl)) || (await this.playerPage(player, pageUrl));
            let found = fire ? fire.url : null;
            if (!fire || !fire.sure) {
                const w = await this.viaWebview(player, pageUrl);
                if (w) found = w;
            }
            if (found) {
                const h = { "User-Agent": UA, "Referer": `${origin}/`, "Origin": origin };
                list = (await this.expand(found, LABEL, h)).map((g) => Object.assign(g, { quality: `${g.quality} (예비) [${this.diag.join(" · ").substring(0, 60)}]` }));
            }
        }
        // 재생 목록 주소가 .m3u8 로 끝나지 않으면 재생용 주소 끝에 "#download.m3u8" (애니24 와 같은 이유)
        for (const v of list) {
            const plain = String(v.url || "").replace(/#.*$/, "");
            v.originalUrl = /\.m3u8?$/i.test(plain.split("?")[0]) ? plain : plain + "#download.m3u8";
        }
        if (!list.length) {
            const wv = typeof evaluateJavascriptViaWebview === "function" ? "" : " · 웹뷰 미지원";
            throw new Error(`영상 주소를 찾지 못했습니다 [${(/^https?:\/\/([^/]+)/.exec(player) || [null, player])[1]}${wv} · ${this.diag.join(" · ")}]`);
        }
        return qualitySort("kotbc_quality", list);
    }

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
            ...notesFilters("kotbc"),
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어와 함께 써도 됨 · 작품·사이트 주소를 붙여 넣으면 바로 열기" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), ruleFilters("kotbc", RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: "kotbc_domain",
            editTextPreference: {
                title: "코티비씨 주소 직접 지정 (선택)",
                summary: `비워 두면 기본 주소(${DEFAULT_BASE_URL}) 또는 자동으로 찾은 주소를 사용합니다.`,
                value: "",
                dialogTitle: "코티비씨 주소",
                dialogMessage: "https:// 로 시작하는 주소 (예: https://k05.kotbc2.com · https://k05.kormovie.com)",
            },
        }, {
            key: "kotbc_auto",
            switchPreferenceCompat: {
                title: "주소 자동 찾기",
                summary: "목록이 안 열리면 주소 안내 사이트와 번호를 바꿔 새 주소를 찾습니다.",
                value: true,
            },
        }, qualityPreference("kotbc_quality")];
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
