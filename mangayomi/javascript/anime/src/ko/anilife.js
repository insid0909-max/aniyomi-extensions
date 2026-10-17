const mangayomiSources = [{
    "name": "애니라이프",
    "lang": "ko",
    "baseUrl": "https://anilife01.tv",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.4",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/anilife.js"
}];

// Aniyomi Anilife.kt(애니라이프)를 망가요미용으로 옮긴 소스. 사이트가 목록·작품·회차·재생 주소를 JSON 으로 준다.
// 목록: /api/anime?page=&limit=24&scope=&status=&day=&genre=&year=&format=&sort=&q=&v=catalog-media-2
// 작품(회차 포함): /api/anime/{id}?v=playback-url-v1, 재생: /api/playback/{id}/{회차} → {videoUrl, backupUrl, subtitleUrl}
const DEFAULT_BASE_URL = "https://anilife01.tv";
const DOMAIN_RE = /^https:\/\/(?:www\.)?anilife\d+\.tv$/;
const HOST_NUM = /anilife(\d+)\.tv/;
const SITE_MARKER = "애니라이프";
const SIGNAL_URL = "https://wankyo83.github.io/tokki-traffic-light/domains.json";
const LABEL = "애니라이프";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함)
const SCOPES = [["전체 작품", ""], ["인기 작품", "popular"], ["최근 업데이트", "updates"]];
const STATUSES = ["전체", "방영중", "완결", "방영예정"];
const DAYS = ["전체", "월", "화", "수", "목", "금", "토", "일"];
const GENRES = [
    "전체", "코미디", "액션", "판타지", "드라마", "로맨스", "일상", "모험", "SF", "초자연", "미스터리", "에치",
    "스포츠", "음악", "메카", "심리", "호러", "마법소녀", "스릴러", "소년", "학원", "서스펜스", "이세계", "미식",
    "중국 애니", "성인 캐스트", "청년", "역사", "초능력", "BL", "환생", "밀리터리", "GL", "우주", "아방가르드",
    "웹툰원작", "신화", "소녀", "무술", "수상작", "탐정", "하렘", "시간여행", "패러디", "레이싱", "직장",
    "어반 판타지", "의인화", "치유",
];
const YEARS = (() => {
    const out = ["전체"];
    for (let y = Math.max(2026, new Date(Date.now() + 9 * 3600000).getUTCFullYear()); y >= 1977; y--) out.push(String(y));
    return out;
})();
const FORMATS = [["전체", ""], ["TV", "TV"], ["극장판", "Movie"], ["OVA", "OVA"], ["ONA", "ONA"]];
const SORTS = [["인기순", "popular"], ["최신순", "latest"], ["평점순", "rating"], ["이름순", "title"]];
const DEFAULT_SORT = 1;
const FILTER_DEFS = [
    ["목록", "scope", SCOPES.map((x) => x[0])],
    ["상태", "status", STATUSES],
    ["요일", "day", DAYS.map((d) => (d === "전체" ? d : `${d}요일`))],
    ["장르", "genre", GENRES],
    ["연도", "year", YEARS],
    ["형식", "format", FORMATS.map((x) => x[0])],
    ["정렬", "sort", SORTS.map((x) => x[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
// 인기 = 인기 작품 · 인기순, 최신 = 최근 업데이트 · 최신순
const DEFAULT_POPULAR = [1, 0, 0, 0, 0, 0, 0];
const DEFAULT_LATEST = [2, 0, 0, 0, 0, 0, 1];

// 사이트 요청 사이 최소 간격 (한꺼번에 많이 요청해 막히는 것을 줄임)
let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 250 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

function str(o, k) {
    const v = o ? o[k] : null;
    return v === null || v === undefined ? "" : String(v).trim();
}

// "2026-10-07" → 그날 0시(한국 시간)의 밀리초
function dayMs(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
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

function ruleText(i) {
    return [
        SCOPES[i[0]][0],
        i[1] > 0 ? STATUSES[i[1]] : null,
        i[2] > 0 ? `${DAYS[i[2]]}요일` : null,
        i[3] > 0 ? GENRES[i[3]] : null,
        i[4] > 0 ? `${YEARS[i[4]]}년` : null,
        i[5] > 0 ? FORMATS[i[5]][0] : null,
        SORTS[i[6]][0],
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
        get: (url, headers) => send((c, u, h) => c.get(u, h), url, headers),
        post: (url, headers, body) => send((c, u, h) => c.post(u, h, body), url, headers),
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
        let auto = "";
        try {
            const p = new SharedPreferences();
            custom = (p.get("anilife_domain") || "").trim().replace(/\/+$/, "");
            auto = (p.getString("anilife_auto_domain", "") || "").trim();
        } catch (e) {
            custom = "";
        }
        if (DOMAIN_RE.test(custom)) return custom;
        // 자동으로 찾은 주소가 확장 업데이트로 바뀐 기본 주소보다 옛 번호면 기본 주소를 씀
        const n = (u) => parseInt((String(u).match(HOST_NUM) || [0, "0"])[1], 10) || 0;
        return DOMAIN_RE.test(auto) && n(auto) >= n(DEFAULT_BASE_URL) ? auto : DEFAULT_BASE_URL;
    }

    autoOn() {
        try {
            const v = new SharedPreferences().get("anilife_auto_on");
            return v !== false && v !== "false";
        } catch (e) {
            return true;
        }
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    apiHeaders(base, refPath) {
        return { "User-Agent": UA, "Referer": `${base || this.getBaseUrl()}${refPath || "/"}`, "Accept": "application/json" };
    }

    /** 사이트 API(JSON) 요청. 접속이 안 되거나 막히면(오류/403/5xx) anilife 번호 주소를 찾아 바꾼 뒤 다시 요청 */
    async api(path, refPath) {
        const base = this.getBaseUrl();
        let res = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(base + path, this.apiHeaders(base, refPath));
                break;
            } catch (e) {
                res = null;
                if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
            }
        }
        const dead = !res || res.statusCode === 403 || res.statusCode === 451 || res.statusCode >= 500;
        // 재생 주소 API 는 앱에서 부르면 원래 403 (사이트 화면 안에서만 허용) → 주소 찾기를 돌리지 않음 (재생 시작이 늦어짐)
        if (dead && this.autoOn() && !path.startsWith("/api/playback/")) {
            const found = await this.discover(base);
            if (found) {
                await siteWait();
                res = await this.client.get(found + path, this.apiHeaders(found, refPath));
            }
        }
        if (!res) throw new Error(`애니라이프 접속 실패: ${base}`);
        let data = null;
        try {
            data = JSON.parse(String(res.body || ""));
        } catch (e) {
            data = null;
        }
        if (res.statusCode >= 400 || !data) {
            const msg = data && data.error ? ` ${String(data.error).substring(0, 60)}` : "";
            throw new Error(`애니라이프 접속 실패 (HTTP ${res.statusCode})${msg}. 주소가 바뀌었으면 설정에서 새 주소를 넣어 주세요.`);
        }
        return data;
    }

    async discover(current) {
        const p = new SharedPreferences();
        const last = Number(p.getString("anilife_auto_at", "0")) || 0;
        if (Date.now() - last < 60000) return null;
        p.setString("anilife_auto_at", String(Date.now()));
        const m = String(current).match(HOST_NUM) || String(DEFAULT_BASE_URL).match(HOST_NUM);
        const cur = parseInt(m[1], 10) || 1;
        const width = m[1].length;
        const host = (v) => `https://anilife${String(v).padStart(width, "0")}.tv`;
        const cands = [];
        // 공개 주소 목록(중앙신호등: 여러 사이트의 최신 주소를 확인해 올려 두는 곳)에 적힌 주소를 먼저 후보로
        try {
            const r = await this.client.get(SIGNAL_URL + "?t=" + Date.now(), { "Accept": "application/json", "Cache-Control": "no-cache" });
            const sig = String((((JSON.parse(String(r.body || "{}")).domains || {}).anilife) || {}).baseUrl || "").replace(/\/+$/, "");
            if (DOMAIN_RE.test(sig) && sig !== current) cands.push(sig);
        } catch (e) {}
        for (let i = Math.max(1, cur - 2); i <= cur + 8; i++) if (host(i) !== current && !cands.includes(host(i))) cands.push(host(i));
        const hits = await Promise.all(cands.map(async (c) => {
            try {
                const r = await this.client.get(c + "/", { "User-Agent": UA });
                return r.statusCode === 200 && String(r.body || "").includes(SITE_MARKER) ? c : null;
            } catch (e) {
                return null;
            }
        }));
        const num = (u) => parseInt((u.match(HOST_NUM) || [0, "0"])[1], 10) || 0;
        const ok = hits.filter((x) => x).sort((a, b) => num(b) - num(a));
        if (ok[0]) p.setString("anilife_auto_domain", ok[0]);
        return ok[0] || null;
    }

    abs(u) {
        u = String(u || "");
        if (!u) return "";
        if (/^https?:\/\//.test(u)) return u;
        if (u.startsWith("//")) return "https:" + u;
        return this.getBaseUrl() + (u.startsWith("/") ? u : "/" + u);
    }

    // ================= 목록 =================
    listPath(idx, page, query) {
        const q = [`page=${page}`, "limit=24"];
        const add = (k, v) => q.push(`${k}=${encodeURIComponent(v)}`);
        if (query) add("q", query);
        if (SCOPES[idx[0]][1]) add("scope", SCOPES[idx[0]][1]);
        if (idx[1] > 0) add("status", STATUSES[idx[1]]);
        if (idx[2] > 0) add("day", DAYS[idx[2]]);
        if (idx[3] > 0) add("genre", GENRES[idx[3]]);
        if (idx[4] > 0) add("year", YEARS[idx[4]]);
        if (idx[5] > 0) add("format", FORMATS[idx[5]][1]);
        add("sort", SORTS[idx[6]][1]);
        add("v", "catalog-media-2");
        return "/api/anime?" + q.join("&");
    }

    /** 목록 카드: 방영 중은 " · 최근 갱신일", 완결·극장판은 " (연도)" */
    title(o, latestMs) {
        const t = str(o, "title") || str(o, "titleOriginal");
        const year = Number(o.year) || 0;
        if ((str(o, "status") === "완결" || str(o, "format") === "Movie") && year > 0 && !t.includes(`(${year})`)) return `${t} (${year})`;
        if (str(o, "status") === "방영중" && latestMs > 0) return `${t} · ${mmdd(latestMs)}`;
        return t;
    }

    card(o) {
        return {
            name: this.title(o, dayMs(str(o, "lastUpdatedAt"))),
            imageUrl: this.abs(str(o, "image") || str(o, "bannerImage")),
            link: `/content/${str(o, "id")}`,
        };
    }

    async listPage(idx, page, query) {
        const data = await this.api(this.listPath(idx, page, query || ""));
        const items = Array.isArray(data.items) ? data.items : [];
        const pg = data.pagination || {};
        return { list: items.map((o) => this.card(o)), hasNextPage: (Number(pg.page) || 1) < (Number(pg.pages) || 1) };
    }

    async getPopular(page) {
        return this.listPage(ruleRead("anilife", true, RULE_SIZES) || DEFAULT_POPULAR, page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead("anilife", false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품 주소(…/content/123)를 붙여 넣으면 그 작품을 바로 열기
        const pasted = /(?:\/content\/|\/api\/anime\/)(\d+)/.exec(query);
        if (pasted) {
            const data = await this.api(`/api/anime/${pasted[1]}?v=playback-url-v1`);
            return { list: data.item ? [this.card(data.item)] : [], hasNextPage: false };
        }
        const idx = FILTER_DEFS.map((d, i) => (i === 6 ? DEFAULT_SORT : 0));
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), RULE_SIZES[k] - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (rule) ruleApply("anilife", rule, idx);
        return this.listPage(idx, page, query);
    }

    // ================= 작품 정보 · 회차 =================
    episodes(o) {
        const id = str(o, "id");
        const arr = Array.isArray(o.episodes) ? o.episodes : [];
        const movie = str(o, "format") === "Movie" && arr.length === 1;
        const used = {};
        const out = [];
        arr.forEach((e, i) => {
            const key = str(e, "key") || str(e, "number") || String(i + 1);
            const hasUrl = ["playbackUrl", "videoUrl", "backupUrl"].some((k) => str(e, k));
            if (e.playable === false && !hasUrl) return;
            let num = Number(e.number);
            if (!(e.number !== null && e.number !== undefined && e.number !== "" && !isNaN(num))) {
                const m = /(\d+(?:\.\d+)?)\s*화/.exec(str(e, "title"));
                num = m ? Number(m[1]) : i + 1;
            }
            const date = dayMs(str(e, "date"));
            const base = movie ? "본편" : num > 0 ? `${num}화` : str(e, "title") || "특별편";
            let n = num;
            while (used[n]) n = Math.round((n + 0.01) * 100) / 100;
            used[n] = true;
            const playback = (str(e, "playbackUrl").replace(/^https?:\/\/[^/]+/, "").split("?")[0]) || `/api/playback/${id}/${key}`;
            out.push({ n, ep: { name: base + (date ? ` (${mmdd(date)})` : ""), url: playback, dateUpload: date ? String(date) : null } });
        });
        out.sort((a, b) => b.n - a.n);
        return out.map((x) => x.ep);
    }

    async getDetail(url) {
        const id = (/(\d+)(?!.*\d)/.exec(String(url)) || [])[1];
        if (!id) throw new Error("잘못된 작품 주소");
        const data = await this.api(`/api/anime/${id}?v=playback-url-v1`);
        const o = data.item;
        if (!o) throw new Error("작품 정보를 찾지 못했습니다");
        const episodes = this.episodes(o);
        const latest = Math.max(0, ...episodes.map((e) => Number(e.dateUpload) || 0)) || dayMs(str(o, "lastUpdatedAt"));
        const ongoing = str(o, "status") === "방영중";
        const tags = [].concat(Array.isArray(o.genres) ? o.genres : [], Array.isArray(o.tags) ? o.tags : [])
            .map((x) => String(x || "").trim()).filter((x, i, a) => x && a.indexOf(x) === i);
        const fmt = str(o, "format") === "Movie" ? "극장판" : str(o, "format");
        const day = str(o, "day") ? `매주 ${str(o, "day")}요일${str(o, "broadcastTime") ? " " + str(o, "broadcastTime") : ""}` : "";
        const info = [
            [fmt, Number(o.year) > 0 ? `${o.year}년` : "", Number(o.episodeCount) > 0 ? `${o.episodeCount}화` : "", str(o, "status")].filter((x) => x).join(" · "),
            [day, str(o, "season")].filter((x) => x).join(" · "),
            str(o, "studio") ? `제작: ${str(o, "studio")}` : "",
            str(o, "director") ? `감독: ${str(o, "director")}` : "",
            str(o, "originalWork") || str(o, "original") ? `원작: ${str(o, "originalWork") || str(o, "original")}` : "",
            str(o, "titleJp") ? `원제: ${str(o, "titleJp")}` : "",
        ].filter((x) => x).join("\n");
        return {
            name: this.title(o, latest),
            imageUrl: this.abs(str(o, "image") || str(o, "bannerImage")),
            link: `${this.getBaseUrl()}/content/${id}`,
            description: [
                ongoing && latest ? `방영 중 · 최근 방영: ${fullDate(latest)}` : "",
                str(o, "description").replace(/\r/g, ""),
                info,
            ].filter((x) => x).join("\n\n"),
            author: str(o, "studio"),
            status: ongoing ? 0 : str(o, "status") === "완결" || str(o, "format") === "Movie" ? 1 : 5,
            genre: tags,
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        const m = /\/api\/playback\/(\d+)\/([^/?#]+)/.exec(String(url));
        if (!m) throw new Error("잘못된 회차 주소입니다. 회차 목록을 새로고침해 주세요");
        let main = "";
        let backup = "";
        let sub = "";
        let apiError = "";
        try {
            // 사이트 재생 화면(/content/작품/회차)에서 부르는 것처럼 그 화면 주소를 Referer 로
            const d = await this.api(`/api/playback/${m[1]}/${m[2]}?request=${Date.now()}-0`, `/content/${m[1]}/${m[2]}`);
            main = str(d, "videoUrl");
            backup = str(d, "backupUrl");
            sub = str(d, "subtitleUrl");
            if (!main && !backup) apiError = "빈 응답 " + JSON.stringify(d).substring(0, 80);
        } catch (e) {
            apiError = String((e && e.message) || e);
        }
        if (!main && !backup) {
            try {
                const d = await this.api(`/api/anime/${m[1]}?v=playback-url-v1`);
                const e = ((d.item || {}).episodes || []).find((x) => str(x, "key") === m[2] || str(x, "number") === m[2]);
                if (e) {
                    main = str(e, "videoUrl");
                    backup = str(e, "backupUrl");
                    sub = sub || str(e, "subtitleUrl");
                }
            } catch (e) {}
        }
        // 그래도 없으면 숨은 웹뷰로 사이트 재생 화면을 열어, 그 화면이 받는 재생 주소를 씀
        if (!main && !backup) {
            const w = await this.viaWebview(`${this.getBaseUrl()}/content/${m[1]}/${m[2]}`, `/api/playback/${m[1]}/${m[2]}`);
            if (w) {
                main = w.videoUrl || "";
                backup = w.backupUrl || "";
                sub = sub || w.subtitleUrl || "";
            } else if (typeof evaluateJavascriptViaWebview !== "function") {
                apiError += " · 웹뷰 미지원";
            } else {
                apiError += " · 웹뷰에서도 못 찾음";
            }
        }
        if (!main && !backup) throw new Error("재생 주소를 받지 못했습니다. 잠시 뒤 다시 시도해 주세요" + (apiError ? ` [${apiError}]` : ""));
        const base = this.getBaseUrl();
        const h = { "User-Agent": UA, "Referer": `${base}/`, "Origin": base };
        const subtitles = sub ? [{ file: this.abs(sub), label: "한국어" }] : [];
        let servers = [[this.abs(main), LABEL], [this.abs(backup), `${LABEL} (대체 1)`]].filter((s) => s[0]);
        servers = servers.filter((s, i) => servers.findIndex((x) => x[0] === s[0]) === i);
        // 기본 주소가 안 열리면 대체 주소를 먼저
        if (servers.length > 1 && !(await mediaWorks(this.client, servers[0][0], h))) servers.reverse();
        let list = [];
        for (const [u, label] of servers) list = list.concat(await hlsExpand(this.client, u, label, h));
        return qualitySort("anilife_quality", list.map((v) => Object.assign(v, { subtitles, audios: [] })));
    }

    /**
     * 숨은 웹뷰에서 재생 화면을 열고, 화면 안에서 재생 주소(API)를 다시 물어보거나
     * 플레이어가 부른 m3u8 주소를 찾아 {videoUrl, backupUrl, subtitleUrl} 로 돌려줌
     */
    async viaWebview(url, apiPath) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        const script = "(function(){var done=false,n=0;function send(o){if(done)return;done=true;" +
            "window.flutter_inappwebview.callHandler('setResponse',JSON.stringify(o));}" +
            "function seen(){var r=performance.getEntriesByType('resource');for(var i=0;i<r.length;i++){" +
            "if(/\\.m3u8(\\?|$)/.test(r[i].name))return r[i].name;}return null;}" +
            "function ask(){fetch(" + JSON.stringify(apiPath) + "+'?request='+Date.now()+'-w',{cache:'no-store',credentials:'same-origin'," +
            "headers:{Accept:'application/json'}}).then(function(r){return r.ok?r.json():null;})" +
            ".then(function(j){if(j&&(j.videoUrl||j.backupUrl))send(j);}).catch(function(){});}" +
            "var t=setInterval(function(){n++;var u=seen();if(u){clearInterval(t);send({videoUrl:u});return;}" +
            "if(n===5||n===15||n===30)ask();},300);})();";
        try {
            const timeout = new Promise((res) => setTimeout(() => res(null), 20000));
            const res = await Promise.race([evaluateJavascriptViaWebview(url, {}, [script]), timeout]);
            if (!res) return null;
            const o = JSON.parse(String(res));
            return o && (o.videoUrl || o.backupUrl) ? o : null;
        } catch (e) {
            return null;
        }
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${host} · 자동 찾기 ${this.autoOn() ? "켜짐" : "꺼짐"}` },
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어와 함께 쓸 수 있음 (작품 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values], i) => ({
            type_name: "SelectFilter", name, param, state: i === 6 ? DEFAULT_SORT : 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), ruleFilters("anilife", RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: "anilife_domain",
            editTextPreference: {
                title: "애니라이프 주소 직접 지정 (선택)",
                summary: `비워 두면 자동으로 찾은 주소나 기본 주소(${DEFAULT_BASE_URL})를 사용합니다.`,
                value: "",
                dialogTitle: "애니라이프 주소",
                dialogMessage: "anilife숫자.tv 형식의 HTTPS 주소만 사용됩니다 (예: https://anilife02.tv).",
            },
        }, {
            key: "anilife_auto_on",
            switchPreferenceCompat: {
                title: "도메인 자동 찾기",
                summary: "접속이 안 되거나 막히면 anilife 번호 주소(현재 번호 -2 ~ +8)를 찾아 자동 변경",
                value: true,
            },
        }, qualityPreference("anilife_quality")];
    }
}
