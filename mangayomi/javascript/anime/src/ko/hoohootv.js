const mangayomiSources = [{
    "name": "후후티비",
    "lang": "ko",
    "baseUrl": "https://db.hoohootv464.xyz",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.25",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/hoohootv.js"
}];

// Aniyomi HoohooTV.kt(후후티비)를 망가요미용으로 옮긴 소스.
// 목록: /tv/분류, /movie/분류 (?page=N), 인기 /popular, 검색 /search?sfl=…&query=,
// 작품: /detail/ID/ (회차 목록은 script#episodes-data JSON, 회차는 ?season=S&episode=E),
// 영상: 회차 화면의 플레이어(iframe)에서 찾고, 없으면 숨은 웹뷰로 플레이어를 열어 영상 요청 주소를 받음.
// jwpcdn 회차: creatorofvideo.com HLS / JW ping 의 mu= 파라미터를 우선 추출.
const HH_KIND = 0; // 0 = 전체, 1 = 영화, 2 = 드라마
const DEFAULT_BASE_URL = "https://db.hoohootv464.xyz";
const SUB_RE = /^([a-z])([a-z])\.hoohootv(\d+)\.([a-z]{2,6})$/;
const DOMAIN_RE = /^https:\/\/(?:[a-z0-9-]+\.)*hoohootv\d*\.[a-z]{2,6}$/;
const HOST_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*hoohootv\d*\.[a-z]{2,6}(?=\/|$)/;
const PORTAL_URL = "https://hoohootv1.com/";
// 주소 안내 글(텔레그래프, 어디서나 열림)·저장소 주소 목록 — 애니요미 후후티비와 같게 (0.1.21)
const GUIDE_URL = "https://telegra.ph/%ED%9B%84%ED%9B%84%ED%8B%B0%EB%B9%84-%EC%B5%9C%EC%8B%A0-%EC%A3%BC%EC%86%8C-09-03";
const HH_TAP = String.raw`var wins=[],prox=[],outN=0;function wrapWin(w){if(!w||w===window)return w;for(var i=0;i<wins.length;i++)if(wins[i]===w)return prox[i];var P;try{P=new Proxy(w,{get:function(t,k){if(k==='postMessage')return function(d){try{var s=typeof d==='string'?d:JSON.stringify(d);rx.push('OUT>'+s);outN++;add(s);}catch(e){}return t.postMessage.apply(t,arguments);};var v;try{v=t[k];}catch(e){return undefined;}return typeof v==='function'?v.bind(t):v;},set:function(t,k,v){try{t[k]=v;}catch(e){}return true;}});}catch(e){return w;}wins.push(w);prox.push(P);return P;}try{var fd=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow');if(fd&&fd.get)Object.defineProperty(HTMLIFrameElement.prototype,'contentWindow',{configurable:true,get:function(){var w;try{w=fd.get.call(this);}catch(e){return null;}return wrapWin(w);}});}catch(e){}try{var sd=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source');if(sd&&sd.get)Object.defineProperty(MessageEvent.prototype,'source',{configurable:true,get:function(){var w=sd.get.call(this);return wrapWin(w);}});}catch(e){}`;
const DOMAIN_LIST_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/domains.json";
const SITE_MARKER = "HOOHOO TV";
const LABEL = "후후티비";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const DRAMA_PATH = "/tv/%EB%93%9C%EB%9D%BC%EB%A7%88";
const ONGOING_MS = 21 * 86400000;
const AIR_TTL_MS = 6 * 3600000;
const ENDED_TTL_MS = 7 * 86400000;
const NEWER_CHECK_MS = 3600000;

// m3u8/mp4 + creatorofvideo HLS
const MEDIA_RE = /https?:\/\/[^"'\s<>\\]+(?:\.(?:m3u8|mp4)|creatorofvideo\.com\/hls\/[^"'\s<>\\]+)(?:\?[^"'\s<>\\]*)?/i;
const CREATOR_M3U8_RE = /https?:\/\/(?:[^/]+\.)?creatorofvideo\.com\/hls\/[^\s"'<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/i;
const MU_RE = /[?&]mu=([^&"'\s<>\\]+)/i;

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

const MEDIA_CACHE = {};

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

/** 문자열에서 creatorofvideo m3u8 / JW mu= / 일반 MEDIA_RE 추출 */
function extractMediaUrl(text) {
    const body = String(text || "").replace(/\\\//g, "/");
    let m = CREATOR_M3U8_RE.exec(body);
    if (m) return m[0];
    m = MU_RE.exec(body);
    if (m) {
        const dec = safeDecode(m[1].replace(/\+/g, " "));
        const c = CREATOR_M3U8_RE.exec(dec) || MEDIA_RE.exec(dec);
        if (c) return (c[0] || c[1] || dec).split("&")[0];
        if (/^https?:\/\//.test(dec) && /\.m3u8/i.test(dec)) return dec.split("&")[0];
    }
    m = MEDIA_RE.exec(body);
    return m ? m[0] : null;
}

async function mediaWorks(client, url, headers) {
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

function withRes(label, url) {
    let path = String(url || "").split("?")[0];
    try {
        path = decodeURIComponent(path);
    } catch (e) {}
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
    } catch (e) {}
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

let APP_NO_UA = false;
let APP_ALT = null;
function appClient(raw) {
    const media = /\.(?:m3u8|mp4|ts|m4s|jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
    const fallbackUa = UA;
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

function hlsHint(list) {
    for (const v of list || []) {
        if (!v || !v.url) continue;
        const plain = String(v.url).replace(/#.*$/, "");
        const path = plain.split("?")[0];
        const hlsLike = /\.txt$|\/hls\/|\/m3\/|master|playlist|jmp2\.uk\/stvp-|creatorofvideo\.com/i.test(path);
        if (/^https?:\/\//.test(plain) && hlsLike && !/\.(?:m3u8?|mp4|mkv|webm|mov|m4v|ts|flv|avi|mp3|aac)$/i.test(path)) {
            v.originalUrl = plain + "#download.m3u8";
        }
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
        // 저장소 주소 목록 → 텔레그래프 안내 글 → 안내 사이트 순으로 적힌 주소를 모음 (0.1.21: 앞 글자까지 바뀌는 주소(cm→db) 대비)
        let found = [];
        const texts = await Promise.all([
            DOMAIN_LIST_URL + "?t=" + Math.floor(Date.now() / 60000), GUIDE_URL, PORTAL_URL + "home", PORTAL_URL,
        ].map(async (u) => {
            try {
                const r = await this.client.get(u, { "User-Agent": UA, "Cache-Control": "no-cache" });
                return Number(r.statusCode) === 200 ? String(r.body || "") : "";
            } catch (e) {
                return "";
            }
        }));
        for (const t of texts) found = found.concat(t.match(/[a-z]{2}\.hoohootv\d+\.[a-z]{2,6}/gi) || []);
        const announced = [...new Set(found.map((x) => x.toLowerCase()))].filter((h) => SUB_RE.test(h)).sort((x, y) => numOf(y) - numOf(x));
        const fromPortal = announced.filter((h) => h !== currentHost &&
            (!newerOnly || numOf(h) > n || (numOf(h) === n && !announced.includes(currentHost))));
        const hit = await this.probeHosts(fromPortal, currentHost);
        if (hit) return hit;
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

    categories() {
        if (HH_KIND === 1) return MOVIE_CATEGORIES;
        if (HH_KIND === 2) return [["드라마", DRAMA_PATH]];
        return CATEGORIES;
    }

    listPath(path, page) {
        return page > 1 ? `${path}${path.includes("?") ? "&" : "?"}page=${page}` : path;
    }

    parseList(html, movieList) {
        const doc = new Document(html);
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
        const id = /hoohootv/.test(query) ? this.idOf(query) : null;
        if (id) {
            if (page > 1) return { list: [], hasNextPage: false };
            const d = await this.getDetail(`/detail/${id}/`);
            return { list: d.name ? [{ name: d.name, imageUrl: d.imageUrl, link: `/detail/${id}/` }] : [], hasNextPage: false };
        }
        if (query) {
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

    airOf(id) {
        const v = this.pref(`air_${id}`, "").split("|");
        return { latest: Number(v[0]) || 0, checked: Number(v[1]) || 0 };
    }

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

    /** 회차 자료 칸 글자: 애니요미처럼 화면 구조(script#episodes-data)로 먼저, 안 되면 글자 모양으로 (0.1.20) */
    episodesRaw(html, doc) {
        try {
            const el = (doc || new Document(html)).select("script#episodes-data, script[id=episodes-data]");
            if (el.length) {
                const t = String(el[0].innerHtml || el[0].text || "").trim();
                if (t) return t;
            }
        } catch (e) {}
        const m = /<script[^>]*\bid\s*=\s*["']?episodes-data\b["']?[^>]*>([\s\S]*?)<\/script>/i.exec(html);
        return m ? m[1].trim() : "";
    }

    episodesData(html, doc) {
        const raw = this.episodesRaw(html, doc);
        this.epDiag = raw ? `회차칸 ${raw.length}자` : "회차칸 없음";
        if (!raw) return [];
        let o = null;
        for (const t of [raw, decodeHtml(raw), raw.replace(/^<!--|-->$/g, "").trim()]) {
            try {
                o = JSON.parse(t);
                break;
            } catch (e) {}
        }
        if (!o) {
            this.epDiag += ` · 읽기 실패 [${raw.substring(0, 60)}]`;
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

    episodesFromLinks(doc) {
        const out = [];
        const seen = {};
        for (const a of doc.select("a[href*='episode=']")) {
            const href = a.attr("href") || "";
            const m = /[?&]season=(\d+)[^#]*?[?&]episode=([^&#]*)/.exec(href) || /[?&]episode=([^&#]*)/.exec(href);
            if (!m) continue;
            const season = m.length > 2 ? parseInt(m[1], 10) || 1 : 1;
            const ep = safeDecode(m.length > 2 ? m[2] : m[1]);
            const key = `${season}:${ep}`;
            if (seen[key]) continue;
            seen[key] = 1;
            const text = a.text.replace(/\s+/g, " ").trim();
            out.push({ season, episode: ep, label: /\d/.test(text) && text.length < 40 ? text : `${ep}화`, date: dateOf(text) });
        }
        if (out.length) this.epDiag = `링크 ${out.length}개`;
        return out;
    }

    async getDetail(url) {
        const id = this.idOf(url) || String(url).replace(/[^A-Za-z0-9_-]/g, "");
        const path = `/detail/${id}/`;
        const html = await this.get(path);
        const doc = new Document(html);
        let eps = this.episodesData(html, doc);
        // 회차 칸이 없으면 화면의 회차 링크(?season=S&episode=E)에서 읽음 (0.1.20)
        if (!eps.length) eps = this.episodesFromLinks(doc);
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
            // 회차 칸은 있는데 못 읽었으면 "본편"으로 숨기지 말고 이유를 보여 줌 (0.1.20)
            if (this.epDiag && this.epDiag !== "회차칸 없음") {
                throw new Error(`회차를 읽지 못했어요 [${this.epDiag} · 제목 ${raw || "?"} · 화면 ${String(html).length}자]`);
            }
            episodes = [{ name: "1 · 본편", url: path, dateUpload: null }];
        } else {
            const multi = new Set(eps.map((e) => e.season)).size > 1;
            // 같은 (시즌, 회)가 두 번 오면 날짜 있는 쪽 하나만 (애니요미 8755 와 같게)
            const seenEp = {};
            const sorted = eps.slice().sort((x, y) => x.season - y.season || (parseFloat(x.episode) || 0) - (parseFloat(y.episode) || 0) || (y.date ? 1 : 0) - (x.date ? 1 : 0))
                .filter((e) => {
                    const k = `${e.season}:${e.episode}`;
                    if (seenEp[k]) return false;
                    seenEp[k] = 1;
                    return true;
                });
            episodes = sorted.map((e) => {
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
            description: [head, ov ? ov.text.trim() : ""].filter((x) => x).join("\n\n"),
            genre,
            status: !eps.length ? 1 : latest > 0 ? (ongoing ? 0 : 1) : 5,
            episodes,
        };
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
        // 회차 화면에 있는 플레이어(서버)를 모두 모아 차례로 시도: jwpcdn 이 아닌 서버 먼저 (jwpcdn 은 망가요미에서 막히는 경우가 많음)
        const players = this.playerCandidates(doc, html);
        if (!players.length) {
            throw new Error("플레이어를 찾지 못했습니다 (로그인이 필요하거나 영상이 없는 회차일 수 있습니다)");
        }
        const diags = [];
        let found = null;
        for (const player of players.slice(0, 4)) {
            const playerHost = (/^https?:\/\/([^/?#]+)/.exec(player) || [null, ""])[1];
            found = await this.tryPlayer(player, playerHost, pageUrl, html);
            if (found) break;
            diags.push(`${playerHost}${this.lastDiag ? ` ${this.lastDiag}` : ""}`);
        }
        if (!found) {
            const why = typeof evaluateJavascriptViaWebview !== "function" ? " [웹뷰 미지원]" : "";
            throw new Error(`영상 주소를 찾지 못했습니다 (서버 ${players.length}개)${why} [${diags.join(" / ")}]`);
        }
        const keys = Object.keys(MEDIA_CACHE);
        if (keys.length >= 30) delete MEDIA_CACHE[keys[0]];
        MEDIA_CACHE[path] = { media: found.media, referer: found.referer, at: Date.now() };
        return this.toVideos(found.media, found.referer);
    }

    /** 회차 화면의 플레이어 주소들: 기본 iframe + 다른 서버 버튼(data-src·data-url·onclick 등) */
    playerCandidates(doc, html) {
        const out = [];
        const add = (u) => {
            u = this.abs(decodeHtml(String(u || "").trim()), this.getBaseUrl());
            if (!/^https?:\/\//.test(u) || out.includes(u)) return;
            if (/\.(?:js|css|png|jpe?g|gif|webp|svg|ico)(?:[?#]|$)/i.test(u)) return;
            if (/google|facebook|doubleclick|cloudflare|kakao|twitter|hoohootv\d*\./i.test(u)) return;
            out.push(u);
        };
        for (const css of ["#iframeContainer iframe", ".playstart iframe", "iframe"]) {
            for (const f of doc.select(css)) add(f.attr("data-src") || f.attr("src"));
        }
        for (const el of doc.select("[data-src],[data-url],[data-link],[data-video],[data-player],[data-embed],[data-iframe]")) {
            if (el.select && /^img$/i.test(el.tagName || "")) continue;
            for (const k of ["data-src", "data-url", "data-link", "data-video", "data-player", "data-embed", "data-iframe"]) add(el.attr(k));
        }
        const re = /(?:onclick|value)\s*=\s*["'][^"']*?(https?:\/\/[^"'\s)]+)/gi;
        let m;
        while ((m = re.exec(html))) add(m[1]);
        // jwpcdn 이 아닌 서버 먼저
        return out.filter((u) => !/jwpcdn/i.test(u)).concat(out.filter((u) => /jwpcdn/i.test(u)));
    }

    /** 플레이어 하나: 글자에서 바로 → 숨은 웹뷰 */
    async tryPlayer(player, playerHost, pageUrl, html) {
        this.lastDiag = "";
        let direct = null;
        try {
            const res = await this.client.get(player, { "User-Agent": UA, "Referer": pageUrl });
            const media = extractMediaUrl(String(res.body || ""));
            if (media) direct = { media, referer: player };
        } catch (e) {}
        if (!direct) {
            const media = extractMediaUrl(html);
            if (media) direct = { media, referer: pageUrl };
        }
        if (direct && await mediaWorks(this.client, direct.media, this.videoHeaders(direct.referer))) return direct;
        // jwpcdn 은 끝까지 시도해 봐도 망가요미에서 영상 주소를 받을 수 없었음(0.1.17 휴대폰 확인: 서버 1개, 안쪽 신호는 contentChecked 뿐)
        // → 30초씩 기다리지 않고 바로 안내
        // 0.1.19 시험: jwpcdn 도 웹뷰로 끝까지 시도 (사용자가 준 스크립트 — fetch·XHR·PerformanceObserver 로 주소 모으기)
        // 0.1.25(사용자 v3): 바깥 화면에 머물며 바깥→안쪽 신호를 엿들음 (안쪽으로 옮기면 플레이어가 멈춤 — 0.1.22~24 확인)
        return (await this.viaWebview(player, pageUrl, playerHost, true)) || direct;
    }

    async toVideos(media, referer) {
        const label = media.includes(".m3u8") || /creatorofvideo\.com/i.test(media) ? `${LABEL} (HLS)` : LABEL;
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
     * 숨은 웹뷰로 플레이어를 열고 m3u8 / creatorofvideo / JW mu= 를 찾음.
     * jwpcdn 이중 iframe은 망가요미에서 안쪽 요청이 안 보일 수 있음.
     */
    async viaWebview(player, pageUrl, playerHost, stay) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        const playAt = this.autoplayHosts().includes(playerHost) ? 2 : 12;
        const script = "(function(){var n=0,played=false,rx=[],urls=[];" +
            // 0.1.19 시험(사용자 제안): 이 화면이 요청한 주소를 fetch·XHR·PerformanceObserver 로 모음
            "function add(u){if(!u)return;u=String(u);if(urls.indexOf(u)===-1)urls.push(u);}" +
            // 0.1.24(사용자 v2): 응답 주소(넘겨준 뒤 최종 주소)도 모음
            "try{var of=window.fetch;if(of){window.fetch=function(){var g=arguments;try{var a=g[0];add(a&&a.url?a.url:a);}catch(e){}var pr=of.apply(this,g);try{pr.then(function(r){try{add(r&&r.url);}catch(e2){}}).catch(function(){});}catch(e){}return pr;};}}catch(e){}" +
            "try{var oo=XMLHttpRequest.prototype.open;if(oo){XMLHttpRequest.prototype.open=function(m,u){var x=this;try{add(u);}catch(e){}try{x.addEventListener('load',function(){try{add(x.responseURL);}catch(e2){}});}catch(e){}return oo.apply(this,arguments);};}}catch(e){}" +
            "try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){add(e.name);});}).observe({type:'resource',buffered:true});}catch(e){}" +
            "function fromUrls(){for(var i=0;i<urls.length;i++){var x=urls[i];if(/creatorofvideo\\.com.*\\.m3u8|\\.(m3u8|mp4)(\\?|$)/i.test(x))return x;var m=fromMu(x);if(m)return m;}return null;}" +
            // 안쪽 플레이어가 바깥 화면으로 보내는 신호(postMessage)를 모아 둠. 영상 주소가 들어 있으면 그 주소를 씀
            "window.addEventListener('message',function(e){try{var s=typeof e.data==='string'?e.data:JSON.stringify(e.data);rx.push('IN>'+s);add(s);}catch(x){}});" +
            // 0.1.25(사용자 v3): 바깥 화면이 안쪽 플레이어에 보내는 신호를 기록만 하고 그대로 전달 (신호를 만들지 않음).
            // 받은 신호의 보낸 곳(e.source)도 같은 감싸기로 맞춰 바깥 코드의 "내 플레이어인가" 비교가 그대로 맞게 함
            HH_TAP +
            "function fromRx(){for(var i=0;i<rx.length;i++){var m=/https?:[^\"'\\s<>]+?(?:\\.m3u8|\\.mp4|creatorofvideo\\.com\\/hls\\/[^\"'\\s<>]+)[^\"'\\s<>]*/i.exec(String(rx[i]).replace(/\\\\\\//g,'/'));if(m)return m[0];}return null;}" +
            "function mute(){document.querySelectorAll('video,audio').forEach(function(v){v.muted=true;v.volume=0;});}" +
            "function abs(u){try{return new URL(u,location.href).href;}catch(e){return u;}}" +
            "function fromMu(u){try{var m=/[?&]mu=([^&]+)/i.exec(u);if(!m)return null;" +
            "var d=decodeURIComponent(m[1].replace(/\\+/g,' '));" +
            "if(/creatorofvideo\\.com.*\\.m3u8|\\.m3u8/i.test(d))return d.split('&')[0];}catch(e){}return null;}" +
            "function pickFile(it){if(!it)return null;if(it.file)return abs(it.file);" +
            "if(it.sources&&it.sources.length){for(var i=0;i<it.sources.length;i++){var s=it.sources[i];if(s&&s.file)return abs(s.file);}}return null;}" +
            // 0.1.24(사용자 v2): JW 플레이어 사건(ready·playlist·playlistItem·play) 듣기 — 설정을 받는 순간 영상 주소를 모음
            "var hooked=false,jwFile=null;function hookJw(){try{if(!window.jwplayer)return false;var p=null;try{p=window.jwplayer();}catch(e){}if(!p||!p.on||!p.id)return false;" +
            "function g(it){var f=pickFile(it);if(f){add(f);jwFile=f;}}" +
            "p.on('ready',function(){try{g(p.getPlaylistItem&&p.getPlaylistItem());}catch(e){}});" +
            "p.on('playlist',function(e){try{var pl=(e&&e.playlist)||(p.getPlaylist&&p.getPlaylist())||[];for(var i=0;i<pl.length;i++)g(pl[i]);}catch(x){}});" +
            "p.on('playlistItem',function(e){try{g((e&&e.item)||(p.getPlaylistItem&&p.getPlaylistItem()));}catch(x){}});" +
            "p.on('play',function(){try{g(p.getPlaylistItem&&p.getPlaylistItem());}catch(e){}});return true;}catch(e){return false;}}" +
            "function jw(){try{if(!window.jwplayer)return null;var players=[];" +
            "try{if(jwplayer().id||jwplayer().getPlaylist)players.push(jwplayer());}catch(e){}" +
            "document.querySelectorAll('[id]').forEach(function(el){try{var p=jwplayer(el.id);if(p&&p.getPlaylist)players.push(p);}catch(e){}});" +
            "for(var pi=0;pi<players.length;pi++){var j=players[pi];var it=null;" +
            "try{it=j.getPlaylistItem&&j.getPlaylistItem();}catch(e){}" +
            "if(!it){try{var pl=j.getPlaylist&&j.getPlaylist();if(pl&&pl[0])it=pl[0];}catch(e){}}" +
            "var f=pickFile(it);if(f)return f;" +
            "try{var cfg=j.getConfig&&j.getConfig();if(cfg){f=pickFile(cfg)||pickFile(cfg.playlist&&cfg.playlist[0]);if(f)return f;}}catch(e){}}" +
            "}catch(e){}return null;}" +
            "function scan(w){try{var r=w.performance.getEntriesByType('resource');for(var i=0;i<r.length;i++){" +
            "var name=r[i].name;" +
            "if(/creatorofvideo\\.com.*\\.m3u8|\\.(m3u8|mp4)(\\?|$)/i.test(name))return name;" +
            "var mu=fromMu(name);if(mu)return mu;}" +
            "var v=w.document.querySelector('video');var s=v&&(v.currentSrc||v.src);" +
            "if(s&&/^https?:/.test(s)&&(/m3u8|creatorofvideo|mp4/i.test(s)))return s;}catch(e){}return null;}" +
            "function find(){var u=jwFile||jw()||scan(window)||fromRx()||fromUrls();if(u)return u;" +
            "var f=document.querySelectorAll('iframe');for(var i=0;i<f.length;i++){try{u=scan(f[i].contentWindow);if(u)return u;}catch(e){}}return null;}" +
            "function inner(){var f=document.querySelectorAll('iframe');for(var i=0;i<f.length;i++){" +
            "var s=f[i].src||f[i].getAttribute('data-src')||'';" +
            "if(/^https?:/.test(s)&&!/challenges\\.cloudflare\\.com|google|facebook|doubleclick/.test(s)&&s!==location.href)return s;}return null;}" +
            "function tryPlay(){played=true;" +
            "try{var j=window.jwplayer&&window.jwplayer();if(j){if(j.setMute)j.setMute(true);if(j.play)j.play();}}catch(e){}" +
            "var v=document.querySelector('video');if(v){v.muted=true;try{var q=v.play();if(q&&q.catch)q.catch(function(){});}catch(e){}}" +
            "var b=document.querySelector('.jw-icon-display,.jw-display-icon-container,.vjs-big-play-button,[aria-label=\"Play\"],.play-button');if(b)b.click();}" +
            "var t=setInterval(function(){n++;mute();if(!hooked&&n%2===0&&hookJw())hooked=true;var u=find();" +
            "if(u){clearInterval(t);window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({u:u,p:played,r:location.href}));return;}" +
            // 0.1.22 진단: 짧은 주소 모양, 안쪽으로 옮기기 전 바깥 화면 주소는 # 뒤에 담아 감(서버로 안 감)
            "function jwst(){try{var j=window.jwplayer&&window.jwplayer();if(!j)return '';var pl=(j.getPlaylist&&j.getPlaylist())||[];return ' (상태 '+(j.getState?j.getState():'?')+' · 목록 '+pl.length+' · 설정 '+(j.getConfig&&j.getConfig()?'Y':'N')+')';}catch(e){return ' (상태 오류)';}}" +
            "function outer(){try{var m=/[#&]hhout=([^&]*)/.exec(location.hash);return m?' || 바깥 '+decodeURIComponent(m[1]):'';}catch(e){return '';}}" +
            "function sh(u){u=String(u).replace(/^https?:\\/\\//,'');var q=u.indexOf('?');return (q>0?u.substring(0,q)+'?…':u).substring(0,45);}" +
            "if(" + (stay ? "false" : "true") + "&&n>=12&&n<=40){var s=inner();if(s){clearInterval(t);" +
            "var o=location.host+': '+urls.map(sh).join(' , ');location.href=s+(s.indexOf('#')<0?'#':'&')+'hhout='+encodeURIComponent(o.substring(0,500));return;}}" +
            "if(n===" + playAt + "||n===" + (playAt + 15) + "||n===" + (playAt + 30) + ")tryPlay();" +
            // 15초 동안 바깥→안쪽 신호가 없으면(스크립트가 들어가기 전에 지나감) 안쪽 플레이어를 한 번 새로고침해 주고받기를 다시 하게 함
            "if(n===50&&outN===0&&!window.__hhRe){window.__hhRe=1;try{var fr=document.querySelector('iframe');if(fr&&fr.src)fr.src=fr.src;}catch(e){}}" +
            "if(n===110){clearInterval(t);var v=document.querySelector('video');" +
            "window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({u:null,p:played," +
            "d:location.host+' | jw:'+(window.jwplayer?'Y':'N')+jwst()+' | hook:'+(hooked?'Y':'N')+' | video:'+(v?'Y':'N')+' | 주소'+urls.length+' | 신호'+rx.length+'(바깥→안 '+outN+')'+(rx.length?' '+rx.join(' / ').substring(0,500):'')" +
            "+' || 안쪽 주소: '+urls.map(sh).join(' , ').substring(0,700)+outer()}));}" +
            "},300);})();";
        try {
            const timeout = new Promise((res) => setTimeout(() => res(null), 50000));
            const res = await Promise.race([
                evaluateJavascriptViaWebview(player, { "Referer": pageUrl }, [script], 48),
                timeout,
            ]);
            if (!res) {
                this.lastDiag = "웹뷰 응답 없음";
                return null;
            }
            const o = JSON.parse(String(res));
            if (o && o.d) {
                this.lastDiag = String(o.d);
                // 오류 칸은 몇 줄만 보여 줌 → 전체 진단을 저장해 필터 맨 위 🩺 줄에 보여 줌 (0.1.23)
                this.setPref("hoohootv_diag", `${new Date().toISOString().substring(5, 16).replace("T", " ")} ${this.lastDiag}`);
            }
            if (!o || !/^https?:\/\//.test(String(o.u || ""))) return null;
            if (o.p && playerHost && playAt > 2) this.rememberAutoplay(playerHost);
            return { media: String(o.u), referer: /^https?:\/\//.test(String(o.r || "")) ? String(o.r) : player };
        } catch (e) {
            return null;
        }
    }

    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        const head = [{ type_name: "HeaderFilter", name: `📡 주소: ${host}` }];
        // 🩺 마지막 재생 진단(시험판): 긴 글을 여러 줄로 나눠 전부 보여 줌
        const diag = this.pref("hoohootv_diag", "");
        if (diag) {
            const parts = diag.split(/ \|\| | , | \| /);
            let line = "🩺 마지막 재생 진단:";
            for (const p of parts) {
                if ((line + " " + p).length > 70) {
                    head.push({ type_name: "HeaderFilter", name: line });
                    line = "🩺 " + p;
                } else {
                    line += " " + p;
                }
            }
            head.push({ type_name: "HeaderFilter", name: line });
        }
        head.push({ type_name: "SeparatorFilter" });
        if (HH_KIND === 2) {
            return head.concat([{ type_name: "HeaderFilter", name: "드라마 목록입니다 (분류 선택 없음). 작품 주소를 검색창에 붙여 넣으면 바로 열기" }]);
        }
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
                // 설정 화면을 만드는 동안 저장된 설정을 읽으면 앱이 가끔 꺼져서(후후티비만 그랬음) 고정 글만 씀. 지금 주소는 필터 맨 위 📡 줄에 표시
                summary: "직접 넣은 주소는 접속되는 동안 계속 씁니다. 끊기면 자동 찾기로 찾은 새 주소를 씁니다. 지금 쓰는 주소는 필터 맨 위에 보입니다.",
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
        }, qualityPreference("hoohootv_quality")];
    }
}
