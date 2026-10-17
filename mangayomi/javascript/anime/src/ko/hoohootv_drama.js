const mangayomiSources = [{
    "name": "후후티비 드라마",
    "lang": "ko",
    "baseUrl": "https://al.hoohootv461.xyz",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.10",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/hoohootv_drama.js"
}];

// Aniyomi HoohooTV.kt(후후티비)를 망가요미용으로 옮긴 소스.
// 목록: /tv/분류, /movie/분류 (?page=N), 인기 /popular, 검색 /search?sfl=…&query=,
// 작품: /detail/ID/ (회차 목록은 script#episodes-data JSON, 회차는 ?season=S&episode=E),
// 영상: 회차 화면의 플레이어(iframe) 글자 안에서 찾고, 없으면 숨은 웹뷰로 플레이어를 열어 영상 요청 주소를 받음.
// 후후티비 영화·드라마 소스(hoohootv_movie.js·hoohootv_drama.js)는 이 파일의 복사본 (이름·pkgPath·HH_KIND 만 다름)
const HH_KIND = 2; // 0 = 전체, 1 = 영화, 2 = 드라마
const DEFAULT_BASE_URL = "https://al.hoohootv461.xyz";
// 주소: 앞 두 글자 + 번호가 바뀜 (fo.hoohootv459.xyz → bd.hoohootv460.xyz → al.hoohootv461.xyz)
const SUB_RE = /^([a-z])([a-z])\.hoohootv(\d+)\.([a-z]{2,6})$/;
const DOMAIN_RE = /^https:\/\/(?:[a-z0-9-]+\.)*hoohootv\d*\.[a-z]{2,6}$/;
const HOST_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*hoohootv\d*\.[a-z]{2,6}(?=\/|$)/;
const PORTAL_URL = "https://hoohootv1.com/";
const SITE_MARKER = "HOOHOO TV";
const LABEL = "후후티비";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const DRAMA_PATH = "/tv/%EB%93%9C%EB%9D%BC%EB%A7%88";
const ONGOING_MS = 21 * 86400000;
const AIR_TTL_MS = 6 * 3600000;
const ENDED_TTL_MS = 7 * 86400000;
const NEWER_CHECK_MS = 3600000;
const MEDIA_RE = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/i;

const CATEGORIES = [
    ["TV 전체", "/tv/all"],
    ["드라마", DRAMA_PATH],
    ["예능", "/tv/Reality"],
    ["토크쇼", "/tv/Talk"],
    ["TV 코미디", "/tv/%EC%BD%94%EB%AF%B8%EB%94%94"],
    ["TV 애니메이션", "/tv/%EC%95%A0%EB%8B%88%EB%A9%94%EC%9D%B4%EC%85%98"],
    ["TV 다큐멘터리", "/tv/%EB%8B%A4%ED%81%90%EB%A9%98%ED%84%B0%EB%A6%AC"],
    ["키즈", "/tv/Kids"],
    ["영화 전체", "/movie/all"],
    ["영화 - 액션", "/movie/%EC%95%A1%EC%85%98"],
    ["영화 - 코미디", "/movie/%EC%BD%94%EB%AF%B8%EB%94%94"],
    ["영화 - 스릴러", "/movie/%EC%8A%A4%EB%A6%B4%EB%9F%AC"],
    ["영화 - 로맨스", "/movie/%EB%A1%9C%EB%A7%A8%EC%8A%A4"],
    ["영화 - 공포", "/movie/%EA%B3%B5%ED%8F%AC"],
    ["영화 - 범죄", "/movie/%EB%B2%94%EC%A3%84"],
    ["영화 - 애니메이션", "/movie/%EC%95%A0%EB%8B%88%EB%A9%94%EC%9D%B4%EC%85%98"],
    ["영화 - 다큐멘터리", "/movie/%EB%8B%A4%ED%81%90%EB%A9%98%ED%84%B0%EB%A6%AC"],
];
const MOVIE_CATEGORIES = CATEGORIES.filter((c) => c[1].startsWith("/movie/")).map((c) => [c[0].replace(/^영화 - /, ""), c[1]]);

let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

/** "2026-09-29" · "2026.09.29" · "26.09.29" → 한국시간 그날 0시 (없으면 0) */
function dateOf(s) {
    s = String(s || "");
    let m = /(\d{4})[-.](\d{1,2})[-.](\d{1,2})/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600000;
    m = /(\d{2})[./](\d{2})[./](\d{2})/.exec(s);
    return m ? Date.UTC(2000 + +m[1], +m[2] - 1, +m[3]) - 9 * 3600000 : 0;
}

function yearOf(ms) {
    return new Date(ms + 9 * 3600000).toISOString().substring(0, 4);
}

// 같은 회차를 다시 열면(이어보기·재시도) 기억해 둔 영상 주소로 바로 재생 (20분)
const MEDIA_CACHE = {};

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

function mmdd(ms) {
    const d = new Date(ms + 9 * 3600000).toISOString();
    return d.substring(5, 7) + "." + d.substring(8, 10);
}

function fullDate(ms) {
    const d = new Date(ms + 9 * 3600000);
    const w = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
    return d.toISOString().substring(0, 10).replace(/-/g, ".") + ` (${w})`;
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

    prefs() {
        try {
            return new SharedPreferences();
        } catch (e) {
            return null;
        }
    }

    pref(key, def) {
        const p = this.prefs();
        try {
            const v = p ? p.getString(key, def) : def;
            return v === null || v === undefined ? def : String(v);
        } catch (e) {
            return def;
        }
    }

    setPref(key, value) {
        try {
            const p = this.prefs();
            if (p) p.setString(key, String(value));
        } catch (e) {}
    }

    // ================= 주소 =================
    // 직접 넣은 주소(접속되는 동안) > 자동으로 찾은 주소 > 기본 주소.
    // 직접 넣은 주소가 끊겨 새 주소를 찾으면 그 주소를 "끊긴 주소"로 표시해 두고 자동 주소를 씀 (지우지 않음)
    getBaseUrl() {
        let manual = "";
        try {
            manual = String(this.prefs().get("hoohootv_domain") || "").trim().replace(/\/+$/, "");
        } catch (e) {
            manual = "";
        }
        const num = (u) => {
            const m = SUB_RE.exec(String(u).replace(/^https?:\/\//, ""));
            return m ? parseInt(m[3], 10) : 0;
        };
        // 확장 업데이트로 바뀐 기본 주소보다 옛 번호인 주소는 쓰지 않음
        const usable = (u) => DOMAIN_RE.test(u) && !(num(u) > 0 && num(u) < num(DEFAULT_BASE_URL));
        if (usable(manual) && manual.replace(/^https:\/\//, "") !== this.pref("hoohootv_manual_dead", "")) return manual;
        const auto = this.pref("hoohootv_auto_domain", "").trim();
        return usable(auto) ? auto : DEFAULT_BASE_URL;
    }

    autoOn() {
        try {
            const v = this.prefs().get("hoohootv_auto_on");
            return v !== false && v !== "false";
        } catch (e) {
            return true;
        }
    }

    /** 자동으로 찾은 주소 저장. 지금 쓰던 주소가 직접 넣은 주소였으면 끊긴 주소로 표시 */
    saveFound(oldHost, newHost) {
        this.setPref("hoohootv_auto_domain", `https://${newHost}`);
        let manual = "";
        try {
            manual = String(this.prefs().get("hoohootv_domain") || "").trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
        } catch (e) {}
        if (manual && manual === oldHost) this.setPref("hoohootv_manual_dead", oldHost);
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    /**
     * 사이트 페이지 받기. 접속이 안 되거나 막히면(오류·403·451·5xx, 안내 사이트로 넘어감) 새 주소를 찾아 다시 요청.
     * 목록 끝을 넘어선 페이지(2쪽 이상)의 404 는 빈 페이지로 ("더 없음")
     */
    async get(path) {
        const base = this.getBaseUrl();
        const baseHost = base.replace(/^https?:\/\//, "");
        const url = /^https?:\/\//.test(path) ? path : base + path;
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, this.getHeaders());
            } catch (e) {
                res = null;
                if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
            }
        }
        const finalUrl = String((res && res.request && res.request.url) || url);
        const finalHost = (/^https?:\/\/([^/?#]+)/.exec(finalUrl) || [null, baseHost])[1];
        if (res && finalHost !== baseHost && SUB_RE.test(finalHost)) this.saveFound(baseHost, finalHost);
        const dead = !res || res.statusCode === 403 || res.statusCode === 451 || res.statusCode >= 500 || !/hoohootv\d+\./.test(finalHost);
        if (dead && this.autoOn() && url.startsWith(base)) {
            const found = await this.discover(baseHost, false);
            if (found) {
                this.saveFound(baseHost, found);
                await siteWait();
                res = await this.client.get(`https://${found}` + url.substring(base.length), this.getHeaders());
            }
        } else if (res && res.statusCode < 400 && this.autoOn()) {
            // 옛 주소가 한동안 같이 열리면 위의 자동 찾기가 안 돌아서, 1시간에 한 번은 새 주소를 가볍게 확인 (기다리지 않음)
            this.checkNewerLater(baseHost);
        }
        if (!res) throw new Error(`후후티비 접속 실패: ${base}. 설정에서 새 주소를 넣어 주세요.`);
        const page = parseInt((/[?&]page=(\d+)/.exec(url) || [0, "0"])[1], 10);
        if (res.statusCode === 404 && page >= 2 && !url.includes("/detail/")) return "<html></html>";
        if (res.statusCode >= 400) throw new Error(`후후티비 접속 실패 (HTTP ${res.statusCode}). 주소가 바뀌었으면 설정에서 새 주소를 넣어 주세요.`);
        return String(res.body || "");
    }

    checkNewerLater(baseHost) {
        const last = Number(this.pref("hoohootv_newer_at", "0")) || 0;
        if (Date.now() - last < NEWER_CHECK_MS) return;
        this.setPref("hoohootv_newer_at", String(Date.now()));
        this.discover(baseHost, true).then((found) => {
            if (found && this.getBaseUrl().replace(/^https?:\/\//, "") === baseHost) this.setPref("hoohootv_auto_domain", `https://${found}`);
        }).catch(() => {});
    }

    // ================= 도메인 자동 찾기 =================
    // 앞 두 글자가 통째로 바뀌면 짐작할 수 없어서, 주소 안내 사이트(hoohootv1.com)에 적힌 주소를 먼저 확인.
    // 못 찾으면 같은 번호의 다른 글자, 번호 +1 ~ +3 의 같은 글자·모든 글자를 차례로 열어 본다
    async discover(currentHost, newerOnly) {
        if (!newerOnly) {
            const last = Number(this.pref("hoohootv_auto_at", "0")) || 0;
            if (Date.now() - last < 60000) return null;
            this.setPref("hoohootv_auto_at", String(Date.now()));
        }
        const m = SUB_RE.exec(currentHost) || SUB_RE.exec(DEFAULT_BASE_URL.replace(/^https:\/\//, ""));
        if (!m) return null;
        const [, a, b, numStr, tld] = m;
        const n = parseInt(numStr, 10);
        const numOf = (h) => {
            const x = SUB_RE.exec(h);
            return x ? parseInt(x[3], 10) : 0;
        };
        let announced = [];
        try {
            const r = await this.client.get(PORTAL_URL, { "User-Agent": UA });
            const found = String(r.body || "").match(/[a-z]{2}\.hoohootv\d+\.[a-z]{2,6}/gi) || [];
            announced = [...new Set(found.map((x) => x.toLowerCase()))].filter((h) => SUB_RE.test(h)).sort((x, y) => numOf(y) - numOf(x));
        } catch (e) {}
        // 1) 안내 사이트에 적힌 주소 (가볍게 확인할 때는 번호가 더 크거나, 같은 번호라도 지금 주소가 안내에서 빠진 경우만)
        const fromPortal = announced.filter((h) => h !== currentHost &&
            (!newerOnly || numOf(h) > n || (numOf(h) === n && !announced.includes(currentHost))));
        const hit = await this.probeHosts(fromPortal, currentHost);
        if (hit) return hit;
        // 2) 짐작 (1시간마다 하는 가벼운 확인에서는 같은 두 글자의 다음 번호만)
        const abc = "abcdefghijklmnopqrstuvwxyz";
        const start = abc.indexOf(b);
        const newer = [];
        for (let d = 1; d <= 3; d++) newer.push(`${a}${b}.hoohootv${n + d}.${tld}`);
        for (let d = 1; d <= 3; d++) for (let i = 0; i < 26; i++) newer.push(`${a}${abc[(start + i) % 26]}.hoohootv${n + d}.${tld}`);
        const same = [];
        for (let i = 1; i < 26; i++) same.push(`${a}${abc[(start + i) % 26]}.hoohootv${n}.${tld}`);
        const guesses = (newerOnly ? newer.slice(0, 3) : same.concat(newer))
            .filter((h, i, arr) => arr.indexOf(h) === i && h !== currentHost && !fromPortal.includes(h));
        return this.probeHosts(guesses, currentHost);
    }

    /** 후보 주소의 /home 을 열어(한 번에 16개씩) 진짜 후후티비인 주소 중 번호가 가장 큰 것 */
    async probeHosts(cands, currentHost) {
        const ok = [];
        for (let i = 0; i < cands.length; i += 16) {
            const hits = await Promise.all(cands.slice(i, i + 16).map(async (h) => {
                try {
                    const r = await this.client.get(`https://${h}/home`, { "User-Agent": UA });
                    return r.statusCode === 200 && String(r.body || "").includes(SITE_MARKER) ? h : null;
                } catch (e) {
                    return null;
                }
            }));
            hits.forEach((h) => { if (h && h !== currentHost) ok.push(h); });
        }
        const num = (h) => parseInt((SUB_RE.exec(h) || [0, 0, 0, "0"])[3], 10);
        ok.sort((x, y) => num(y) - num(x));
        return ok[0] || null;
    }

    abs(u, base) {
        u = String(u || "").trim();
        if (!u) return "";
        if (/^https?:\/\//.test(u)) return u;
        if (u.startsWith("//")) return "https:" + u;
        return (base || this.getBaseUrl()) + (u.startsWith("/") ? u : "/" + u);
    }

    idOf(url) {
        return (/\/detail\/([A-Za-z0-9_-]+)/.exec(String(url || "")) || [null, null])[1];
    }

    // ================= 목록 =================
    categories() {
        if (HH_KIND === 1) return MOVIE_CATEGORIES;
        if (HH_KIND === 2) return [["드라마", DRAMA_PATH]];
        return CATEGORIES;
    }

    listPath(path, page) {
        return page > 1 ? `${path}${path.includes("?") ? "&" : "?"}page=${page}` : path;
    }

    /** 목록·검색 공통: 작품 링크(/detail/)가 있는 카드 */
    parseList(html, movieList) {
        const doc = new Document(html);
        // 카드 옆 제목(.subject a)을 주소별로 모아 둠
        const subjects = {};
        for (const s of doc.select(".subject a")) {
            const id = this.idOf(s.attr("href"));
            if (id && !subjects[id]) subjects[id] = s.text.trim();
        }
        let links = doc.select("a.thumb[href*='/detail/']");
        if (!links.length) links = doc.select("a[href*='/detail/']").filter((a) => a.select("img").length);
        const seen = {};
        const list = [];
        const now = Date.now();
        const todo = [];
        for (const a of links) {
            const id = this.idOf(a.attr("href"));
            if (!id || seen[id]) continue;
            seen[id] = true;
            const img = first(a, "img");
            const title = (subjects[id] || (img ? img.attr("alt") : "") || a.attr("title") || "").trim();
            if (!title) continue;
            const imageUrl = img ? (img.attr("data-src") || img.attr("src") || "") : "";
            const air = this.airOf(id);
            if (!movieList) {
                const ttl = air.latest > 0 && now - air.latest <= ONGOING_MS ? AIR_TTL_MS : ENDED_TTL_MS;
                if (!air.checked || now - air.checked > ttl) todo.push(id);
            }
            list.push({ name: this.titleWithAir(title, air.latest), imageUrl: this.abs(imageUrl), link: `/detail/${id}/` });
        }
        // 목록에는 날짜가 없어서 작품 페이지(회차 날짜)를 뒤에서 몇 개씩 읽어 저장 → 다음 목록부터 표시 (기다리지 않음)
        if (todo.length) this.fillAir(todo.slice(0, 8));
        const pageLinks = doc.select(".pagination a[href*='page=']");
        const cur = first(doc, ".pagination .current-page");
        const curN = cur ? parseInt(cur.text.trim(), 10) || 0 : 0;
        const hasNextPage = pageLinks.some((x) => x.text.includes("»")) ||
            (curN > 0 && pageLinks.some((x) => (parseInt((/[?&]page=(\d+)/.exec(x.attr("href")) || [0, "0"])[1], 10) || 0) > curN));
        return { list, hasNextPage };
    }

    async listPage(path, page) {
        return this.parseList(await this.get(this.listPath(path, page)), path.startsWith("/movie/"));
    }

    ruleSizes() {
        return [this.categories().length];
    }

    // 인기 = 사이트 "인기" 메뉴, 최신 = TV 전체(최근 올라온 순). 영화·드라마 소스는 그 목록
    async getPopular(page) {
        const r = HH_KIND === 2 ? null : ruleRead("hoohootv", true, this.ruleSizes());
        if (r) return this.listPage(this.categories()[r[0]][1], page);
        return this.listPage(HH_KIND === 1 ? "/movie/all" : HH_KIND === 2 ? DRAMA_PATH : "/popular", page);
    }

    get supportsLatest() {
        return HH_KIND === 0;
    }

    async getLatestUpdates(page) {
        const r = ruleRead("hoohootv", false, this.ruleSizes());
        return this.listPage(r ? this.categories()[r[0]][1] : "/tv/all", page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품 주소를 붙여 넣으면 그 작품을 바로 열기
        const id = /hoohootv/.test(query) ? this.idOf(query) : null;
        if (id) {
            if (page > 1) return { list: [], hasNextPage: false };
            const d = await this.getDetail(`/detail/${id}/`);
            return { list: d.name ? [{ name: d.name, imageUrl: d.imageUrl, link: `/detail/${id}/` }] : [], hasNextPage: false };
        }
        if (query) {
            // 사이트 검색창과 같은 방식: 제목·시즌 제목·태그에서 찾기
            const q = `/search?sfl=${encodeURIComponent("common_title||season_title||tag_title")}&sop=and&query=${encodeURIComponent(query)}`;
            return this.parseList(await this.get(this.listPath(q, page)), false);
        }
        let cat = 0;
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            if (f.name === "분류") cat = Math.min(Math.max(Number(f.state) || 0, 0), this.categories().length - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (rule && HH_KIND !== 2) ruleApply("hoohootv", rule, [cat]);
        return this.listPage(this.categories()[cat][1], page);
    }

    // ================= 방영일·연도 =================
    /** 저장된 (최근 방영일, 읽은 시각) */
    airOf(id) {
        const v = this.pref(`air_${id}`, "").split("|");
        return { latest: Number(v[0]) || 0, checked: Number(v[1]) || 0 };
    }

    /** 방영 중이면 " · MM.dd"(최근 방영일), 끝났으면 " (yyyy)" (망가요미는 서재 제목도 새로 바뀜) */
    titleWithAir(title, latest) {
        const plain = String(title || "").replace(/\s*·\s*\d{2}\.\d{2}$/, "");
        if (!(latest > 0) || !plain) return plain;
        if (Date.now() - latest <= ONGOING_MS) return `${plain.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "")} · ${mmdd(latest)}`;
        return /\((?:19|20)\d{2}\)\s*$/.test(plain) ? plain : `${plain} (${yearOf(latest)})`;
    }

    async fillAir(ids) {
        if (this.filling || Date.now() < (Number(this.pref("air_pause_until", "0")) || 0)) return;
        this.filling = true;
        try {
            for (const id of ids) {
                let ok = false;
                try {
                    const html = await this.get(`/detail/${id}/`);
                    if (html.includes(SITE_MARKER)) {
                        this.saveAir(id, this.episodesData(html));
                        ok = true;
                    }
                } catch (e) {
                    ok = false;
                }
                if (!ok) {
                    // 막히는 기미가 보이면 10분 쉼
                    this.setPref("air_pause_until", String(Date.now() + 600000));
                    return;
                }
                await new Promise((r) => setTimeout(r, 700));
            }
        } finally {
            this.filling = false;
        }
    }

    saveAir(id, eps) {
        const latest = Math.max(0, ...eps.map((e) => e.date));
        this.setPref(`air_${id}`, `${latest}|${Date.now()}`);
        return latest;
    }

    /** episodes-data: {"시즌": [{"episode": "1", "date": …, "label": "1화"}, …]} → [{season, episode, label, date}] */
    episodesData(html) {
        const m = /<script[^>]*id=["']episodes-data["'][^>]*>([\s\S]*?)<\/script>/.exec(html);
        if (!m) return [];
        let o = null;
        try {
            o = JSON.parse(m[1].trim());
        } catch (e) {
            return [];
        }
        const out = [];
        for (const s of Object.keys(o || {})) {
            for (const e of o[s] || []) {
                const ep = String(e.episode === undefined || e.episode === null ? "" : e.episode);
                const label = String(e.label || `${ep}화`);
                const date = e.date && e.date !== "null" ? String(e.date) : "";
                out.push({ season: parseInt(s, 10) || 1, episode: ep, label, date: dateOf(date) || dateOf(label) });
            }
        }
        return out;
    }

    // ================= 작품 정보 · 회차 =================
    async getDetail(url) {
        const id = this.idOf(url) || String(url).replace(/[^A-Za-z0-9_-]/g, "");
        const path = `/detail/${id}/`;
        const html = await this.get(path);
        const doc = new Document(html);
        const eps = this.episodesData(html);
        const latest = this.saveAir(id, eps);
        const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/.exec(html);
        let raw = og ? decodeHtml(og[1]).replace(/\s*-\s*후후티비\s*$/, "").trim() : "";
        if (!raw) {
            const h1 = first(doc, ".share-title h1");
            raw = h1 ? h1.text.split(" - ")[0].trim() : "";
        }
        const genre = doc.select(".share-title .datetime-hit a").map((a) => a.text.trim()).filter((x) => x);
        const ov = first(doc, ".overview");
        const ongoing = latest > 0 && Date.now() - latest <= ONGOING_MS;
        const head = eps.length && latest > 0 ? `${ongoing ? "방영 중" : "종영"} · 최근 방영: ${fullDate(latest)}` : "";
        // 표지: og:image 는 사이트 로고(HOOHOO)라서 쓰지 않고, 작품 포스터(/media/poster_image/) 중 제목과 같은 것 → 첫 포스터
        let poster = "";
        for (const img of doc.select("img")) {
            const src = img.attr("data-src") || img.attr("src") || "";
            if (!/poster_image/.test(src)) continue;
            if (!poster) poster = src;
            if (raw && (img.attr("alt") || "").trim() === raw) {
                poster = src;
                break;
            }
        }
        if (!poster) poster = (/["'(]([^"'()\s]*\/media\/poster_image\/[^"'()\s]+)/.exec(html) || [null, ""])[1];
        let episodes;
        if (!eps.length) {
            episodes = [{ name: "1 · 본편", url: path, dateUpload: null }];
        } else {
            const multi = new Set(eps.map((e) => e.season)).size > 1;
            // 오래된 회차가 앞 → 앱에는 최신 회차가 위로
            const sorted = eps.slice().sort((x, y) => x.season - y.season || (parseFloat(x.episode) || 0) - (parseFloat(y.episode) || 0));
            episodes = sorted.map((e) => {
                // "12화 (26.09.29)" → "12화 (09.29)"
                const base = e.label.replace(/\s*\(\d{2,4}[./-]\d{1,2}[./-]\d{1,2}\)/, "").trim();
                const name = e.date ? `${base} (${mmdd(e.date)})` : e.label;
                return {
                    name,
                    url: `${path}?season=${e.season}&episode=${e.episode}`,
                    dateUpload: e.date ? String(e.date) : null,
                    scanlator: multi ? `시즌${e.season}` : "",
                };
            }).reverse();
        }
        return {
            name: this.titleWithAir(raw, latest),
            imageUrl: poster ? this.abs(poster) : "",
            link: this.getBaseUrl() + path,
            description: [this.recentDiag(), head, ov ? ov.text.trim() : ""].filter((x) => x).join("\n\n"),
            genre,
            status: !eps.length ? 1 : latest > 0 ? (ongoing ? 0 : 1) : 5,
            episodes,
        };
    }

    /** 2시간 안에 재생이 안 됐으면 그 진단을 작품 설명 맨 위에 보여 줌 (망가요미 설정 화면 글은 새로 안 바뀜) */
    recentDiag() {
        const at = Number(this.pref("hoohootv_last_diag_at", "0")) || 0;
        if (Date.now() - at > 7200000) return "";
        const d = this.pref("hoohootv_last_diag", "");
        return d ? `🩺 재생 진단 (재생이 안 되면 이 글을 캡처해 주세요)\n${d}` : "";
    }

    // ================= 영상 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    videoHeaders(referer) {
        const origin = (/^(https?:\/\/[^/?#]+)/.exec(String(referer || "")) || [null, ""])[1];
        const h = { "User-Agent": UA, "Referer": referer };
        if (origin) h["Origin"] = origin;
        return h;
    }

    async videoListInner(url) {
        const path = /^https?:\/\//.test(url) ? url.replace(HOST_RE, "") : url;
        const pageUrl = this.getBaseUrl() + path;
        const hit = MEDIA_CACHE[path];
        if (hit && Date.now() - hit.at < 1200000 && await mediaWorks(this.client, hit.media, this.videoHeaders(hit.referer))) {
            return this.toVideos(hit.media, hit.referer);
        }
        const html = await this.get(path);
        const doc = new Document(html);
        const f = first(doc, "#iframeContainer iframe") || first(doc, ".playstart iframe");
        const player = f ? this.abs(f.attr("data-src") || f.attr("src") || "", this.getBaseUrl()) : "";
        if (!/^https?:\/\//.test(player)) throw new Error("플레이어를 찾지 못했습니다 (로그인이 필요하거나 영상이 없는 회차일 수 있습니다)");
        const playerHost = (/^https?:\/\/([^/?#]+)/.exec(player) || [null, ""])[1];
        // jwpcdn 플레이어(보안 확인이 걸림)와 재생해야 주소를 내는 것으로 기억된 플레이어는 글자 읽기를 건너뜀
        const needsWebview = player.includes("jwpcdn") || this.autoplayHosts().includes(playerHost);
        let direct = null;
        if (!needsWebview) {
            try {
                const res = await this.client.get(player, { "User-Agent": UA, "Referer": pageUrl });
                const m = MEDIA_RE.exec(String(res.body || "").replace(/\\\//g, "/"));
                if (m) direct = { media: m[0], referer: player };
            } catch (e) {}
        }
        let found = direct && await mediaWorks(this.client, direct.media, this.videoHeaders(direct.referer)) ? direct : null;
        this.lastDiag = "";
        if (!found) found = await this.viaWebview(player, pageUrl, playerHost);
        if (!found) found = direct;
        if (!found) {
            const why = typeof evaluateJavascriptViaWebview !== "function" ? " [웹뷰 미지원]" : this.lastDiag ? ` [${this.lastDiag}]` : "";
            throw new Error(why ? `영상 못 찾음 (자세한 내용은 작품 설명 맨 위)${why}` : `영상 주소를 찾지 못했습니다: ${playerHost}`);
        }
        const keys = Object.keys(MEDIA_CACHE);
        if (keys.length >= 30) delete MEDIA_CACHE[keys[0]];
        MEDIA_CACHE[path] = { media: found.media, referer: found.referer, at: Date.now() };
        return this.toVideos(found.media, found.referer);
    }

    async toVideos(media, referer) {
        const label = media.includes(".m3u8") ? `${LABEL} (HLS)` : LABEL;
        return qualitySort("hoohootv_quality", await hlsExpand(this.client, media, label, this.videoHeaders(referer)));
    }

    autoplayHosts() {
        return this.pref("hoohootv_autoplay_hosts", "").split(",").filter((x) => x);
    }

    rememberAutoplay(host) {
        const hosts = this.autoplayHosts().filter((h) => h !== host).concat([host]).slice(-10);
        this.setPref("hoohootv_autoplay_hosts", hosts.join(","));
    }

    /**
     * 숨은 웹뷰로 플레이어를 열고, 플레이어가 부른 m3u8·mp4 주소를 돌려받음.
     * 처음엔 소리를 끈 채 기다리고, 4.5초가 지나도 없으면 재생을 눌러 봄 (재생해야 주소를 내는 플레이어).
     * 재생을 눌러서 찾은 플레이어는 기억해 두었다가 다음부터 바로 재생
     */
    async viaWebview(player, pageUrl, playerHost) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        const playAt = this.autoplayHosts().includes(playerHost) ? 2 : 15;
        // 플레이어 안에 또 다른 화면(iframe)이 있으면 그 안의 요청은 바깥에서 안 보여서(애니요미는 모든 화면의 요청이 보임),
        // 같은 주소 계열이면 안쪽 기록도 보고, 3.6초가 지나도 영상이 없으면 안쪽 화면 주소로 옮겨 감 (옮긴 화면에서 이 스크립트가 다시 돎).
        // Cloudflare 확인 화면(challenges.cloudflare.com)은 건드리지 않음
        const script = "(function(){var n=0,played=false,rx=[];" +
            // 안쪽 플레이어가 바깥 화면으로 보내는 신호도 모아 둠 (진단용)
            "window.addEventListener('message',function(e){try{rx.push((e.origin||'').replace(/^https?:\\/\\//,'')+' '+(typeof e.data==='string'?e.data:JSON.stringify(e.data)).substring(0,200));}catch(x){}});" +
            "function mute(){document.querySelectorAll('video,audio').forEach(function(v){v.muted=true;v.volume=0;});}" +
            "function scan(w){try{var r=w.performance.getEntriesByType('resource');for(var i=0;i<r.length;i++){" +
            "if(/\\.(m3u8|mp4)(\\?|$)/i.test(r[i].name))return r[i].name;}" +
            "var v=w.document.querySelector('video');var s=v&&(v.currentSrc||v.src);if(s&&/^https?:/.test(s)&&/\\.(m3u8|mp4)/i.test(s))return s;}catch(e){}return null;}" +
            // JW Player 는 영상 칸을 만들기 전에도 설정된 영상 주소(playlist)를 알려 줌 (확장자가 없어도 그 주소를 씀)
            "function jw(){try{var j=window.jwplayer&&window.jwplayer();if(!j||!j.getPlaylistItem)return null;var it=j.getPlaylistItem()||(j.getPlaylist&&j.getPlaylist()[0]);" +
            "var f=it&&(it.file||(it.sources&&it.sources[0]&&it.sources[0].file));return f?new URL(f,location.href).href:null;}catch(e){return null;}}" +
            "function find(){var u=scan(window)||jw();if(u)return u;var f=document.querySelectorAll('iframe');" +
            "for(var i=0;i<f.length;i++){try{u=scan(f[i].contentWindow);if(u)return u;}catch(e){}}return null;}" +
            "function inner(){var f=document.querySelectorAll('iframe');for(var i=0;i<f.length;i++){var s=f[i].src||f[i].getAttribute('data-src')||'';" +
            "if(/^https?:/.test(s)&&!/challenges\\.cloudflare\\.com|google|facebook|doubleclick/.test(s)&&s!==location.href)return s;}return null;}" +
            "var t=setInterval(function(){n++;mute();var u=find();" +
            "if(u){clearInterval(t);window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({u:u,p:played,r:location.href}));return;}" +
            // 옮기기 전 바깥 화면 코드 앞부분을 window.name 에 남겨 둠 (옮긴 화면의 진단에서 같이 보여 줌)
            // 안쪽 플레이어는 바깥 화면이 iframe 을 다 불러온 뒤 보내는 신호(postMessage)를 받아야 시작함.
            // 바깥 화면의 iframe load 처리기를 가짜 iframe 으로 한 번 더 불러 그 신호 내용을 받아 두고(window.name 에 담아 옮김),
            // 안쪽 화면으로 옮긴 뒤 같은 신호를 바깥 화면 주소에서 온 것으로 넣어 줌 (바깥 화면이 원래 보내는 것과 같은 내용)
            "if(n>=12&&n<=40){var s=inner();if(s){clearInterval(t);var cap=[];var fake={id:'player_iframe',src:s,contentWindow:{postMessage:function(d){cap.push(d);}}};" +
            "try{var real=document.getElementById('player_iframe')||document.querySelector('iframe');window.the_iframe=fake;" +
            "var ev=window.jQuery&&jQuery._data&&real&&jQuery._data(real,'events');" +
            // 처리기가 진짜 iframe 을 직접 가리켜도 받도록, 잠깐 iframe 의 contentWindow 를 가짜로 바꿔 진짜 iframe 으로도 한 번 부름
            "var pd=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow');" +
            "if(ev&&ev.load)ev.load.forEach(function(h){try{h.handler.call(fake,{type:'load',target:fake,currentTarget:fake,delegateTarget:fake});}catch(e){}" +
            "if(!cap.length&&pd&&real){try{Object.defineProperty(HTMLIFrameElement.prototype,'contentWindow',{configurable:true,get:function(){return fake.contentWindow;}});" +
            "h.handler.call(real,{type:'load',target:real,currentTarget:real,delegateTarget:real});}catch(e){}try{Object.defineProperty(HTMLIFrameElement.prototype,'contentWindow',pd);}catch(e){}}});" +
            "if(real&&real.onload)try{real.onload.call(fake,{type:'load',target:fake});}catch(e){}}catch(e){}" +
            "setTimeout(function(){var code='';try{var c=[].slice.call(document.scripts).filter(function(e){return !e.src;}).map(function(e){return e.text.replace(/\\s+/g,' ');}).join(' ;; ');" +
            "var k=c.indexOf('player_iframe');code=c.substring(Math.max(0,k-100),k+1500);}catch(e){}" +
            "var m=[];cap.forEach(function(d){try{JSON.stringify(d);m.push(d);}catch(e){m.push(String(d));}});" +
            "try{window.name='hh:'+JSON.stringify({o:location.origin,m:m,c:code,rx:rx.slice(-6)});}catch(e){}location.href=s;},1500);return;}}" +
            // 바깥 화면에서 받아 온 신호가 있으면 한 번(그래도 시작 안 하면 6초 뒤 한 번 더) 넣어 줌
            "if((n===2||n===22)&&/^hh:/.test(window.name)){try{var hh=JSON.parse(window.name.substring(3));var j0=window.jwplayer&&window.jwplayer();" +
            "if(n===2||!(j0&&j0.getState)){(hh.m||[]).forEach(function(d){window.dispatchEvent(new MessageEvent('message',{data:d,origin:hh.o}));});}}catch(e){}}" +
            "if(n===" + playAt + "||n===" + (playAt + 15) + "){played=true;var v=document.querySelector('video');" +
            "if(v){v.muted=true;try{var q=v.play();if(q&&q.catch)q.catch(function(){});}catch(e){}}" +
            "try{var j=window.jwplayer&&window.jwplayer();if(j&&j.play){if(j.setMute)j.setMute(true);j.play();}}catch(e){}" +
            "var b=document.querySelector('.jw-icon-display,.jw-display-icon-container,.vjs-big-play-button,.plyr__control--overlaid,.play-button,[aria-label=Play]');if(b)b.click();}" +
            // 19초가 지나도 못 찾으면 무엇이 보였는지 알려 줌 (제목·주소·받은 파일 수·영상 칸·안쪽 화면 주소·글자·마지막 요청들)
            "if(n===63){clearInterval(t);var r=performance.getEntriesByType('resource');var last=[];" +
            "for(var i=0;i<r.length;i++){var nm=r[i].name;if(r[i].initiatorType==='script'||r[i].initiatorType==='link'||/\\.(svg|css|js|woff2?|png|gif|ico)(\\?|$)|cdn-cgi|beacon|cloudflareinsights/i.test(nm))continue;" +
            "last.push(r[i].initiatorType.substring(0,3)+':'+nm.replace(/^https?:\\/\\//,'').substring(0,60));}" +
            "var js='없음';try{var j=window.jwplayer&&window.jwplayer();if(window.jwplayer)js=(j&&j.getState?j.getState():'설정전')+(j&&j.getPlaylist?' 목록'+(j.getPlaylist()||[]).length:'');}catch(e){js='오류 '+String(e).substring(0,30);}" +
            "var v=document.querySelector('video');var f=document.querySelector('iframe');" +
            "window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({u:null,p:played," +
            "d:location.host+' | 신호 '+(function(){try{var hh=JSON.parse(window.name.substring(3));return (hh.m||[]).length+'개 '+JSON.stringify(hh.m||[]).substring(0,160);}catch(e){return '없음';}})()+' | jw '+js+' | 영상'+(v?'있음':'없음')+' | 요청 '+(last.slice(-4).join(' , ')||'없음')+' | 파일'+r.length+" +
            "' | iframe '+(f?((f.src||'주소없음').replace(/^https?:\\/\\//,'').substring(0,40)):'없음')+" +
            "' | 글자 '+((document.body&&document.body.innerText)||'').replace(/\\s+/g,' ').substring(0,40)," +
            // 설정 화면에 보여 줄 자세한 내용: 안에 든 화면인지, 앞 화면 주소, 스크립트 주소, 페이지 코드 앞부분
            "x:'top '+(window.top===window)+' | ref '+(document.referrer||'없음').substring(0,60)+' | src '+[].slice.call(document.scripts).map(function(e){return (e.src||'').replace(/^https?:\\/\\/[^/]+/,'');}).filter(function(e){return e;}).join(',').substring(0,250)+" +
            "' | inline '+[].slice.call(document.scripts).filter(function(e){return !e.src;}).map(function(e){return e.text.replace(/\\s+/g,' ');}).join(' ;; ').substring(0,300)+" +
            "' | body '+(document.body?document.body.innerHTML.replace(/\\s+/g,' ').substring(0,100):'없음')+' | 바깥이 받은 신호 '+(function(){try{return JSON.stringify(JSON.parse(window.name.substring(3)).rx||[]);}catch(e){return '없음';}})()+' | outer '+(function(){try{return JSON.parse(window.name.substring(3)).c;}catch(e){return '없음';}})()}));}" +
            "},300);})();";
        try {
            // 망가요미 웹뷰는 화면을 다 불러온 뒤(보안 확인 화면이 있으면 그다음 화면에서도) 스크립트를 넣음 → 넉넉히 36초
            const started = Date.now();
            const timeout = new Promise((res) => setTimeout(() => res(null), 36000));
            const res = await Promise.race([evaluateJavascriptViaWebview(player, { "Referer": pageUrl }, [script], 35), timeout]);
            if (!res) {
                this.lastDiag = `웹뷰 응답 없음 ${Math.round((Date.now() - started) / 1000)}초 (화면을 다 불러오지 못했거나 스크립트가 안 돌았음)`;
                return null;
            }
            const o = JSON.parse(String(res));
            if (o && o.d) this.lastDiag = String(o.d);
            if (o && o.x) {
                const text = `${new Date(Date.now() + 9 * 3600000).toISOString().substring(5, 16)} ${o.d} || ${o.x}`.substring(0, 4000);
                this.setPref("hoohootv_last_diag", text);
                // 망가요미는 설정 화면 설명을 설치할 때 한 번만 만들어 두는 듯 → 항목을 누르면 나오는 입력칸 값에도 넣어 둠 (늘 최신)
                this.setPref("hoohootv_diag_view", text);
                this.setPref("hoohootv_last_diag_at", String(Date.now()));
            }
            if (!o || !/^https?:\/\//.test(String(o.u || ""))) return null;
            if (o.p && playerHost && playAt > 2) this.rememberAutoplay(playerHost);
            return { media: String(o.u), referer: /^https?:\/\//.test(String(o.r || "")) ? String(o.r) : player };
        } catch (e) {
            return null;
        }
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        const head = [{ type_name: "HeaderFilter", name: `📡 주소: ${host}` }, { type_name: "SeparatorFilter" }];
        if (HH_KIND === 2) return head.concat([{ type_name: "HeaderFilter", name: "드라마 목록입니다 (분류 선택 없음). 작품 주소를 검색창에 붙여 넣으면 바로 열기" }]);
        const names = this.categories().map((c) => c[0]);
        const defaults = HH_KIND === 1 ? ["영화 전체", "영화 전체"] : ["인기", "TV 전체"];
        return head.concat([
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)" },
            {
                type_name: "SelectFilter", name: "분류", param: "cat", state: 0,
                values: names.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
            },
        ], ruleFilters("hoohootv", this.ruleSizes(), defaults, (i) => names[i[0]]));
    }

    getSourcePreferences() {
        return [{
            key: "hoohootv_domain",
            editTextPreference: {
                title: "후후티비 주소 직접 지정 (선택)",
                summary: `직접 넣은 주소는 접속되는 동안 계속 씁니다. 끊기면 자동 찾기로 찾은 새 주소를 씁니다. 지금 주소: ${this.getBaseUrl()}`,
                value: "",
                dialogTitle: "후후티비 주소",
                dialogMessage: `https:// 로 시작하는 후후티비 주소 (기본: ${DEFAULT_BASE_URL})`,
            },
        }, {
            key: "hoohootv_auto_on",
            switchPreferenceCompat: {
                title: "도메인 자동 찾기",
                summary: "접속이 안 되면 바로, 접속돼도 1시간마다 주소 안내 사이트(hoohootv1.com)에 적힌 새 주소를 먼저 확인합니다. 못 찾으면 다음 글자·번호 주소를 짐작해 찾습니다.",
                value: true,
            },
        }, qualityPreference("hoohootv_quality"), {
            key: "hoohootv_diag_view",
            editTextPreference: {
                title: "마지막 재생 진단 (눌러서 나오는 칸의 내용을 캡처해 주세요)",
                summary: this.pref("hoohootv_last_diag", "") || "아직 없음",
                value: "",
                dialogTitle: "마지막 재생 진단",
                dialogMessage: this.pref("hoohootv_last_diag", "") || "아직 없음",
            },
        }];
    }
}
