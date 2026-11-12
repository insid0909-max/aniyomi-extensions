const mangayomiSources = [{
    "name": "티비착",
    "lang": "ko",
    "baseUrl": "https://tvchak208.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": true,
    "version": "0.1.56",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/tvchak.js"
}];

// Aniyomi TVchak.kt(티비착)를 망가요미용으로 옮긴 소스 - MacCMS 사이트, 재생 페이지의 player_aaaa 에 영상 주소가 들어 있음
const DEFAULT_BASE_URL = "https://tvchak208.com";
const DOMAIN_RE = /^https:\/\/(?:tvchak\d+\.com|tvchak\.life)$/;
// 비상 주소 (사용자가 알려 줌, 2026-10-28) — 번호 주소가 모두 안 될 때 마지막으로
const EMERGENCY_BASE = "https://tvchak.life";
// 최신 주소 안내 페이지 (사용자가 알려 줌, 2026-11-01)
const GUIDE_URL = "https://tvchak.org/main.html";
const HOST_NUM = /tvchak(\d+)\.com/;
const SITE_MARKER = "티비착";
const PLAYER_REFERER = "https://ckp2.wiselife.blog/";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const MEDIA_RE = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/i;

const TYPES = [
    ["전체", ""], ["영화", "1"], ["드라마", "2"], ["드라마 - 월화", "13"], ["드라마 - 수목", "14"],
    ["드라마 - 금요/주말", "15"], ["드라마 - 일일", "21"], ["드라마 - 다시보기", "22"], ["숏드", "39"],
    ["예능", "3"], ["예능 - 월요일", "23"], ["예능 - 화요일", "24"], ["예능 - 수요일", "25"], ["예능 - 목요일", "26"],
    ["예능 - 금요일", "27"], ["예능 - 토요일", "28"], ["예능 - 일요일", "29"], ["애니", "4"],
];
const SORTS = [["최신순", "time"], ["인기순", "hits"]];

const RULE_SIZES = [TYPES.length, SORTS.length];

// ---------- 목록 카드용 연도/방영일 저장 ----------
const ONGOING_DAYS = 21;
const AIR_TTL_MS = 6 * 3600000;
const ENDED_TTL_MS = 7 * 86400000;

// 저장된 시리즈 연도 (사이트 표기)
function seriesYear(p, id) {
    const y = String(p.getString(`air_${id}`, "") || "").split("|")[2] || "";
    return /^(?:19|20)\d{2}$/.test(y) ? y : "";
}

// 저장된 최근 방영일 [방영일, 읽은 시각]. 없으면 [0, 0]
function airOf(p, id) {
    const v = String(p.getString(`air_${id}`, "") || "").split("|");
    return [Number(v[0]) || 0, Number(v[1]) || 0];
}

// 회차 이름 "26/10/02" → 한국시간 그날 0시
function airDate(label) {
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(String(label || "").trim());
    return m ? Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3600000 : 0;
}

// 상세 페이지에서 영화 연도 또는 시리즈 최근 방영일을 읽어 저장
function saveInfo(p, id, doc) {
    let links = doc.select("#tagContent a[href*='/vod/play/'], .content_playlist a[href*='/vod/play/']");
    if (!links.length) links = doc.select("a[href*='/vod/play/']");
    const seen = {};
    const labels = [];
    for (const a of links) {
        const h = a.attr("href");
        if (seen[h]) continue;
        seen[h] = true;
        labels.push(a.text.trim());
    }
    const y = doc.selectFirst(".scroll-content a[href*='/year/']");
    const year = y ? y.text.trim() : "";
    if (labels.length <= 1) {
        p.setString(`year_${id}`, /^(?:19|20)\d{2}$/.test(year) ? year : "-");
    } else {
        // 시리즈는 "-" 로 표시하고, 최근 방영일·읽은 시각·연도는 따로 저장
        const latest = Math.max(0, ...labels.map(airDate));
        p.setString(`year_${id}`, "-");
        p.setString(`air_${id}`, `${latest}|${Date.now()}|${year}`);
    }
}

// ---------- 접속 속도 제한 · 화질 나누기 ----------
// 사이트로 가는 요청 사이에 최소 간격 (한꺼번에 많이 요청하면 사이트가 403으로 막음)
let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
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

// 옛 주소가 끊기지 않고 "접속 주소 안내" 페이지(새 주소 링크만 있는 작은 페이지)를 보여 주면,
// 거기 적힌 더 큰 번호의 같은 사이트 주소 중 진짜 사이트(marker 가 보임)를 돌려줌
async function noticeTarget(ext, body, base, marker) {
    body = String(body || "");
    if (!body || body.length >= 30000 || body.indexOf(marker) >= 0) return null;
    if (!/<html|<!doctype/i.test(body.substring(0, 3000))) return null; // JSON·API 응답은 제외
    const host = base.replace(/^https?:\/\//, "");
    const head = host.substring(0, host.lastIndexOf("."));
    const m = /(\d+)(?!.*\d)/.exec(head);
    if (!m) return null;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${esc(head.substring(0, m.index))}\\d+${esc(head.substring(m.index + m[1].length))}\\.[a-z]{2,6}`, "gi");
    const num = (s) => {
        const x = /(\d+)(?!.*\d)/.exec(String(s).replace(/^https?:\/\//, "").replace(/\.[a-z]{2,6}$/i, ""));
        return x ? parseInt(x[1], 10) : 0;
    };
    const cur = parseInt(m[1], 10);
    const cands = [...new Set((body.match(re) || []).map((x) => "https://" + x.toLowerCase()))]
        .filter((x) => DOMAIN_RE.test(x) && num(x) > cur).sort((a, b) => num(b) - num(a));
    for (const c of cands) {
        try {
            const r = await ext.client.get(c + "/", { "User-Agent": UA });
            if (r.statusCode === 200 && String(r.body || "").indexOf(marker) >= 0) return c;
        } catch (e) {}
    }
    return null;
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
const ADDR_HOST = /^(?:tvchak\d+\.com|tvchak\.life)$/;
const ADDR_MARK = SITE_MARKER;
const ADDR_UA = UA;
const ADDR_PREF = "tvchak_domain";

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
// 목록 화면 5분 저장 (getDoc)
const PAGE_CACHE = {};

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
    // 보안 확인을 못 마친 것은 주소가 바뀐 게 아님 → 주소 찾기를 돌리지 않고 그 안내 그대로 (시간도 아낌)
    if (err && /보안 확인/.test(String((err && err.message) || err))) throw err;
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
    getBaseUrl() {
        let custom = "";
        let auto = "";
        try {
            const p = new SharedPreferences();
            custom = (p.get("tvchak_domain") || "").trim().replace(/\/+$/, "");
            auto = (p.getString("tvchak_auto_domain", "") || "").trim();
        } catch (e) {
            custom = "";
        }
        if (DOMAIN_RE.test(custom)) {
            // 직접 넣은 주소는 바로 씀. 단 자동 찾기로 그보다 번호가 큰 진짜 사이트 주소가 확인되면 그 주소로 바꾸고 설정 칸도 고침
            const num = (u) => { const x = /(\d+)(?!.*\d)/.exec(String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\.[a-z]{2,6}$/i, "")); return x ? parseInt(x[1], 10) : 0; };
            if (DOMAIN_RE.test(auto) && auto !== custom && num(auto) > num(custom) && this.autoOn()) {
                try {
                    new SharedPreferences().setString("tvchak_domain", auto);
                } catch (e) {
                    // 저장 실패는 무시 (이번 요청은 새 주소로)
                }
                return auto;
            }
            return custom;
        }
        // 자동으로 찾은 주소가 확장 업데이트로 바뀐 기본 주소보다 옛 번호면 기본 주소를 씀
        const n = (u) => parseInt((/(\d+)(?!.*\d)/.exec(String(u).replace(/\.[a-z]{2,6}$/i, "")) || [0, "0"])[1], 10) || 0;
        return DOMAIN_RE.test(auto) && (n(auto) >= n(DEFAULT_BASE_URL) || n(auto) === 0) ? auto : DEFAULT_BASE_URL;
    }

    autoOn() {
        try {
            const v = new SharedPreferences().get("tvchak_auto_on");
            return v !== false && v !== "false";
        } catch (e) {
            return true;
        }
    }

    headers(referer) {
        return { "User-Agent": UA, "Referer": referer || `${this.getBaseUrl()}/` };
    }

    /** 접속이 안 되면(오류/5xx) tvchak 번호 주소를 찾아 바꾼 뒤 다시 요청 */
    async getHtml(path, noDiscover) {
        const base = this.getBaseUrl();
        const url = path.startsWith("http") ? path : base + path;
        let res = null;
        let notice = null;
        // 연결 끊김·시간 초과면 잠깐 쉬고 한 번 더 시도한 뒤에 주소 찾기로 넘어감
        for (let attempt = 0; attempt < 2; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, this.headers());
                // 사이트가 응답했으면(빈 응답·보안 확인 화면 포함, 5xx 제외) 주소는 그대로 → 주소 찾기 안 함.
                // 보안 확인 화면은 getPage 가 웹뷰로 처리 (사용자 기록 2026-11-03: 보안확인 2.2 + 주소찾기 2.6 — 빈 응답에도 주소 찾기를 돌렸음)
                // 접근 차단(451)은 주소가 막힌 것 → 주소 찾기 (2026-11-07)
                if (res.statusCode < 500 && res.statusCode !== 451) {
                    const body = String(res.body || "");
                    notice = res.statusCode === 200 && body.length > 0 && this.autoOn() ? await noticeTarget(this, body, base, "/vod/detail/") : null;
                    if (!notice) return { html: body, base, res };
                }
                break;
            } catch (e) {
                res = null;
                if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
            }
        }
        // 보안 확인 직후 다시 받기에서는 주소 찾기를 하지 않음 (방금 사이트가 응답했으니 주소는 그대로, 사용자 기록 2026-11-03: 주소찾기 3.6초)
        const found = notice || (this.autoOn() && !noDiscover ? await this.discover(base) : null);
        if (notice) new SharedPreferences().setString("tvchak_auto_domain", notice);
        if (!found) {
            if (res) return { html: res.body, base, res };
            throw new Error(`접속 실패: ${url}`);
        }
        const r2 = await this.client.get(found + url.substring(base.length), this.headers(`${found}/`));
        return { html: r2.body, base: found, res: r2 };
    }

    async getDoc(path) {
        // 목록 화면은 5분 동안 다시 받지 않음 → 나갔다 들어오거나 탭을 오가도 사이트에 다시 묻지 않아
        // 보안 확인 화면을 만날 일이 줄어듦 (통과 상태가 얼마나 가는지는 사이트가 정해서 확장이 늘릴 수 없음)
        const listLike = !/\/vod\/(?:detail|play)\//.test(path);
        const key = this.getBaseUrl() + path;
        const hit = listLike ? PAGE_CACHE[key] : null;
        if (hit && Date.now() - hit.at < 5 * 60000) return { doc: new Document(hit.html), base: hit.base };
        const { html, base } = await this.getPage(path);
        if (listLike) {
            for (const k in PAGE_CACHE) if (Date.now() - PAGE_CACHE[k].at >= 5 * 60000) delete PAGE_CACHE[k];
            PAGE_CACHE[key] = { at: Date.now(), html, base };
        }
        return { doc: new Document(html), base };
    }

    /** 사이트(CloudFront)가 일정 시간마다 실제 페이지 대신 보안 확인 페이지를 보냄 → 빈 목록 대신 안내 */
    async getPage(path) {
        const r = await this.getHtml(path);
        if (String(r.html || "").includes("maccms")) return r;
        // 앱이 숨은 WebView 실행을 지원하면, 그 안에서 보안 확인을 끝내고 실제 페이지 내용을 받아 씀
        const url = path.startsWith("http") ? path : r.base + path;
        let html = null;
        // 망가요미는 목록을 40초까지만 기다림(넘으면 "TimeoutException", 2026-11-03 사용자 화면) → 전체 30초 안에 끝냄.
        // 숨은 WebView 는 한 번에 최대 15초. 결과를 못 받아도 그 사이 통과 쿠키가 저장됐을 수 있으니 원래 요청을 다시 해 본다.
        // 두 번째 웹뷰는 시간이 충분히 남았을 때만
        const start = Date.now();
        const left = () => 30000 - (Date.now() - start);
        for (let i = 0; i < 2 && left() > 8000; i++) {
            html = await this.viaWebview(url, Math.min(15000, left() - 4000));
            if (html && html.includes("maccms")) return { html, base: r.base };
            if (left() < 2000) break;
            const again = await this.getHtml(path, true);
            if (String(again.html || "").includes("maccms")) return again;
        }
        throw new Error("사이트 보안 확인을 자동으로 마치지 못했어요. 오른쪽 위 지구본(웹뷰)으로 한 번 열었다 닫은 뒤 다시 불러오세요." +
            ` [진단: ${this.diag(r, html)}]`);
    }

    /** 보안 확인 페이지가 어떤 것인지 알 수 있게 짧게 요약 (캡처해서 보내 주시면 원인 파악용) */
    diag(r, webHtml) {
        const body = String(r.html || "");
        const res = r.res || {};
        const h = res.headers || {};
        const pick = (k) => {
            for (const key in h) if (key.toLowerCase() === k) return String(h[key]).substring(0, 60);
            return "";
        };
        const title = (/<title>([^<]*)/i.exec(body) || [null, ""])[1].trim().substring(0, 40);
        const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ").trim().substring(0, 80);
        const hints = ["awswaf", "challenge", "captcha", "cf-", "turnstile", "location.reload", "document.cookie"]
            .filter((w) => body.toLowerCase().includes(w));
        return [
            `상태 ${res.statusCode}`,
            `크기 ${body.length}`,
            `제목 "${title}"`,
            `server ${pick("server")}`,
            pick("x-amzn-waf-action") ? `waf ${pick("x-amzn-waf-action")}` : "",
            `웹뷰 ${typeof evaluateJavascriptViaWebview === "function" ? (webHtml ? "응답" + String(webHtml).length : "응답없음") : "미지원"}`,
            hints.length ? `단서 ${hints.join(",")}` : "",
            `내용 "${text}"`,
        ].filter((x) => x).join(" · ");
    }

    async viaWebview(url, waitMs) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        // 페이지에 실제 내용(maccms)이 나타날 때까지 기다렸다가 HTML 을 앱으로 돌려줌.
        // 확인 화면은 확인이 끝나면 스스로 새로고침하는데, 새로 열린 화면에는 이 스크립트가 다시 안 들어갈 수 있음 →
        // 확인 화면 안에서 1.5초마다 같은 주소를 다시 받아 보고(사이트가 준 통과 쿠키 그대로), 진짜 목록이 오면 그 내용을 돌려줌
        const script = "(function(){var done=false;function send(h){if(done)return;done=true;" +
            "window.flutter_inappwebview.callHandler('setResponse',h);}" +
            "function f(){var h=document.documentElement.outerHTML;if(h.indexOf('maccms')>=0){send(h);return true;}return false;}" +
            "if(f())return;var n=0;var t=setInterval(function(){if(done||f()){clearInterval(t);return;}n++;" +
            "if(n%5===0&&window.fetch){fetch(location.href,{credentials:'include'}).then(function(r){return r.text();})" +
            ".then(function(h){if(h&&h.indexOf('maccms')>=0){clearInterval(t);send(h);}}).catch(function(){});}},300);})();";
        try {
            const timeout = new Promise((res) => setTimeout(() => res(null), waitMs || 15000));
            const res = await Promise.race([
                evaluateJavascriptViaWebview(url, {}, [script]),
                timeout,
            ]);
            return res ? String(res) : null;
        } catch (e) {
            return null;
        }
    }

    async discover(current) {
        const p = new SharedPreferences();
        const last = Number(p.getString("tvchak_auto_at", "0")) || 0;
        if (Date.now() - last < 60000) return null;
        p.setString("tvchak_auto_at", String(Date.now()));
        const num = (u) => parseInt((u.match(HOST_NUM) || [0, "0"])[1], 10) || 0;
        const cur = num(current) || num(DEFAULT_BASE_URL);
        // 저장소 주소 목록 파일에 적힌 주소 먼저 (작품 링크가 있는 진짜 티비착일 때만)
        const listed = await listedDomain(this.client, "tvchak");
        if (listed && listed !== current && DOMAIN_RE.test(listed)) {
            try {
                const r = await this.client.get(listed + "/", { "User-Agent": UA });
                const body = String(r.body || "");
                if (r.statusCode === 200 && body.includes(SITE_MARKER) && body.includes("/vod/detail/")) {
                    p.setString("tvchak_auto_domain", listed);
                    return listed;
                }
            } catch (e) {
                // 안내 페이지로
            }
        }
        // 먼저 최신 주소 안내 페이지(tvchak.org, 해외에서도 열림)에 적힌 번호 주소 중 진짜 티비착인 가장 큰 번호
        let guideBody = "";
        try {
            const r = await this.client.get(GUIDE_URL, { "User-Agent": UA });
            guideBody = r.statusCode === 200 ? String(r.body || "") : "";
        } catch (e) {
            guideBody = "";
        }
        const listedInGuide = [...new Set((guideBody.match(/tvchak\d+\.com/gi) || []).map((x) => "https://" + x.toLowerCase()))]
            .sort((a, b) => num(b) - num(a)).slice(0, 3);
        for (const c of listedInGuide) {
            try {
                const r = await this.client.get(c + "/", { "User-Agent": UA });
                if (r.statusCode === 200 && String(r.body || "").includes(SITE_MARKER)) {
                    if (c === current) return null;
                    p.setString("tvchak_auto_domain", c);
                    return c;
                }
            } catch (e) {
                // 다음 주소
            }
        }
        const cands = [];
        for (let i = Math.max(1, cur - 5); i <= cur + 30; i++) {
            const c = `https://tvchak${i}.com`;
            if (c !== current) cands.push(c);
        }
        const hits = await Promise.all(cands.map(async (c) => {
            try {
                const r = await this.client.get(c + "/", { "User-Agent": UA });
                return r.statusCode === 200 && String(r.body || "").includes(SITE_MARKER) ? c : null;
            } catch (e) {
                return null;
            }
        }));
        const ok = hits.filter((x) => x).sort((a, b) => num(b) - num(a));
        let found = ok[0] || null;
        // 번호 주소가 모두 안 열리면 비상 주소 tvchak.life: 화면에 적힌 번호 주소, 아니면 비상 주소가 진짜 사이트(작품 링크 있음)일 때 그대로
        // (해외에서는 OTT 안내 글만 보여 줘서 쓰지 않음)
        if (!found) {
            const page = async (c) => {
                try {
                    const r = await this.client.get(c + "/", { "User-Agent": UA });
                    const body = String(r.body || "");
                    return r.statusCode === 200 && body.includes(SITE_MARKER) && body.includes("/vod/detail/") ? body : null;
                } catch (e) {
                    return null;
                }
            };
            if (await page(current)) return null;
            let em = "";
            try {
                const r = await this.client.get(EMERGENCY_BASE + "/", { "User-Agent": UA });
                em = r.statusCode === 200 ? String(r.body || "") : "";
            } catch (e) {
                em = "";
            }
            // 한국에서도 비상 주소는 OTT 안내 글이고, "티비착 바로가기" 버튼 주소(지금 번호 주소)는 /content.json 에 있음
            try {
                const r = await this.client.get(EMERGENCY_BASE + "/content.json", { "User-Agent": UA });
                if (r.statusCode === 200) em += String(r.body || "");
            } catch (e) {
                // 화면 글만으로 찾음
            }
            const listed = [...new Set((em.match(/tvchak\d+\.com/gi) || []).map((x) => "https://" + x.toLowerCase()))]
                .filter((c) => c !== current).sort((a, b) => num(b) - num(a));
            for (const c of listed) {
                if (await page(c)) {
                    found = c;
                    break;
                }
            }
            if (!found && em.includes(SITE_MARKER) && em.includes("/vod/detail/") && EMERGENCY_BASE !== current) found = EMERGENCY_BASE;
        }
        if (found) p.setString("tvchak_auto_domain", found);
        return found;
    }

    // ================= 목록 =================
    showPath(type, sort, page) {
        return "/index.php/vod/show" + (type ? `/id/${type}` : "") + `/by/${sort}` + (page > 1 ? `/page/${page}` : "") + ".html";
    }

    async popularBase(page) {
        return this.parseList(await this.getDoc(`/index.php/vod/show2/by/hits/id/100${page > 1 ? `/page/${page}` : ""}.html`));
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return addrGuard(this, page, () => this.latestGuarded(page));
    }

    async latestGuarded(page) {
        await statusRefresh(this.client);
        const saved = ruleRead("tvchak", false, RULE_SIZES);
        if (saved) return this.withYears(await this.filterPage(page, saved), TYPES[saved[0]][1] === "1");
        return this.withYears(await this.latestBase(page));
    }

    // 분류 없는 최신 목록 주소는 사이트에서 열리지 않아, 첫 화면(오늘의 핫업데이트 + 분류별 최신)을 쓴다
    async latestBase(page) {
        const r = this.parseList(await this.getDoc("/"));
        return { list: page > 1 ? [] : r.list, hasNextPage: false };
    }

    async searchBase(query, page, filters) {
        // 사이트 작품 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
        const byUrl = /^https?:\/\/(?:tvchak\d+\.com|tvchak\.life)(?:\/.*?)?\/vod\/(?:detail|play)\/id\/(\d+)/.exec((query || "").trim());
        if (byUrl) {
            const link = `/index.php/vod/detail/id/${byUrl[1]}.html`;
            const { doc, base } = await this.getDoc(link);
            const t = doc.selectFirst("h1.movie-title");
            const img = doc.selectFirst(".poster img");
            const name = t ? t.text.trim() : "";
            return { list: name ? [{ name, imageUrl: img ? this.resolveUrl(`${base}/`, img.attr("src")) : "", link }] : [], hasNextPage: false };
        }
        if (query && query.trim()) {
            const q = encodeURIComponent(query.trim());
            const path = page > 1 ? `/index.php/vod/search/page/${page}/wd/${q}.html` : `/index.php/vod/search.html?wd=${q}`;
            return this.parseList(await this.getDoc(path));
        }
        const idx = [0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (f.type_name !== "SelectFilter") continue;
            if (f.param === "type") idx[0] = f.state || 0;
            if (f.param === "sort") idx[1] = f.state || 0;
            if (f.param === "rule") rule = f.state || 0;
        }
        ruleApply("tvchak", rule, idx);
        return this.filterPage(page, idx);
    }

    // idx = [분류, 정렬] 선택 번호
    async filterPage(page, idx) {
        const type = TYPES[idx[0]][1];
        const sort = SORTS[idx[1]][1];
        if (!type) return sort === "hits" ? this.popularBase(page) : this.latestBase(page);
        return this.parseList(await this.getDoc(this.showPath(type, sort, page)));
    }

    parseList({ doc, base }) {
        const main = doc.selectFirst(".mobile-main") || doc;
        const seen = {};
        const list = [];
        for (const box of main.select(".movie-list-item, .vod-search-list")) {
            const a = box.selectFirst("a[href*='/vod/detail/id/']");
            if (!a) continue;
            const link = this.toPath(a.attr("href"));
            if (!link || seen[link]) continue;
            const t = box.selectFirst(".movie-title");
            const name = ((t && (t.attr("title") || t.text)) || "").trim();
            if (!name) continue;
            seen[link] = true;
            list.push({ name, imageUrl: this.thumbOf(box, base), link });
        }
        return { list, hasNextPage: this.hasNextPage(doc) };
    }

    thumbOf(box, base) {
        const lazy = box.selectFirst(".movie-post-lazyload");
        if (!lazy) {
            const img = box.selectFirst("img");
            return img ? this.resolveUrl(`${base}/`, img.attr("src")) : "";
        }
        const d = lazy.attr("data-original");
        if (d && /^https?:/.test(d)) return d;
        const m = /url\(['"]?([^'")]+)/.exec((lazy.attr("style") || "").replace(/&quot;/g, "\""));
        return m && /^https?:/.test(m[1]) ? m[1] : "";
    }

    hasNextPage(doc) {
        const cur = doc.selectFirst("#page .page-current");
        const curNum = cur ? parseInt(cur.text.trim(), 10) : NaN;
        if (isNaN(curNum)) return false;
        let max = 0;
        for (const a of doc.select("#page a[href]")) {
            const m = /\/page\/(\d+)/.exec(a.attr("href"));
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return max > curNum;
    }

    // 목록 카드 제목 뒤에 정보를 붙임: 영화와 방영이 끝난 드라마·예능은 연도 "(2024)", 방영 중이면 최근 방영일 " · 10.04".
    // 목록 페이지에는 둘 다 없어서 작품 화면을 열 때(getDetail) 읽어 폰에 저장해 둔 것만 붙인다.
    // 예전엔 목록마다 작품 화면 1개를 몰래 읽었지만, 사이트 보안 확인(HTTP 202)에 매번 막혀 0개였음 →
    // 웹뷰로 통과시키면 목록이 2~4초 늦어져서 몰래 읽기는 뺌 (사용자 선택, 2026-11-12, 0.1.56)
    async withYears(result) {
        let p;
        try {
            p = new SharedPreferences();
        } catch (e) {
            return result;
        }
        const idOf = (x) => (/\/id\/(\d+)/.exec(x.link) || [])[1];
        const now = Date.now();
        for (const x of result.list) {
            const id = idOf(x);
            const y = id ? p.getString(`year_${id}`, "") : "";
            if (/^(?:19|20)\d{2}$/.test(y)) {
                if (!x.name.includes(y)) x.name = `${x.name} (${y})`;
            } else if (y === "-") {
                const latest = airOf(p, id)[0];
                if (!latest) continue;
                const k = new Date(latest + 9 * 3600000);
                if (now - latest <= ONGOING_DAYS * 86400000) {
                    // 방영 중: 제목 뒤에 최근 방영일
                    const pad = (n) => String(n).padStart(2, "0");
                    x.name = `${x.name} · ${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())}`;
                } else {
                    // 방영이 끝남: 제목 뒤에 연도 (사이트 표기, 없으면 마지막 방영 연도)
                    const sy = seriesYear(p, id) || String(k.getUTCFullYear());
                    if (!x.name.includes(sy)) x.name = `${x.name} (${sy})`;
                }
            }
        }
        return result;
    }

    // ================= 상세 / 회차 =================
    async getDetail(url) {
        const { doc, base } = await this.getDoc(this.toPath(url));
        // 목록 카드에도 같은 연도/방영일이 붙도록 저장
        try {
            const id = (/\/id\/(\d+)/.exec(this.toPath(url)) || [])[1];
            if (id) saveInfo(new SharedPreferences(), id, doc);
        } catch (e) {
            // 저장 실패는 무시
        }
        const title = doc.selectFirst("h1.movie-title");
        const poster = doc.selectFirst(".poster img");
        const sum = doc.selectFirst("#sum_tag");
        const boxes = doc.select("#tagContent .play_list_box");
        const lists = boxes.length ? boxes : doc.select(".content_playlist");
        const tabs = doc.select("#tag .swiper-slide, #tag a").map((e) => e.text.trim());
        const episodes = [];
        const seen = {};
        lists.forEach((box, bi) => {
            // 서버가 여러 개면 서버 이름을 "스캔레이터"로 넣어 앱에서 서버별로 거를 수 있게 함
            const server = lists.length > 1 ? tabs[bi] || `서버 ${bi + 1}` : "";
            const links = box.select("a[href*='/vod/play/']");
            links.forEach((a, i) => {
                const path = this.toPath(a.attr("href"));
                if (!path || seen[path]) return;
                seen[path] = true;
                const label = a.text.trim() || "바로보기";
                const d = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(label);
                // 망가요미는 이름 맨 앞 숫자를 회차 번호로 써서 "26/10/02"처럼 연도로 시작하면 같은 해 회차를 중복으로 숨긴다
                // → 날짜·특집처럼 회차 번호가 없는 이름은 순번을 붙임 (가장 오래된 회차가 1)
                const hasNo = /\d+\s*(?:화|회)/.test(label) && !d;
                // 날짜만 있는 이름은 "235회 (10.02)" 처럼 (애니요미와 같은 모양)
                const name = hasNo ? label : d ? `${links.length - i}회 (${d[2]}.${d[3]})` : `${links.length - i}회 · ${label}`;
                episodes.push({
                    name,
                    url: path,
                    scanlator: server,
                    dateUpload: d ? String(Date.UTC(2000 + +d[1], +d[2] - 1, +d[3]) - 9 * 3600000) : null,
                });
            });
        });
        const plot = sum ? sum.text.trim() : "";
        const rawName = title ? title.text.trim() : "";
        let name = rawName;
        let status = 5;
        let description = plot;
        if (episodes.length <= 1) {
            // 영화(회차 1개): 제목 옆에 개봉 연도
            name = this.titleWithYear(rawName, doc);
            status = 1;
        } else {
            // 드라마·예능: 가장 최근 방영일로 방영 중/종영 판단.
            // 제목: 방영 중이면 "제목 · 10.04", 끝났으면 "제목 (2019)" — 망가요미는 서재 작품 제목도 업데이트 때마다 새로 받으므로 날짜가 따라 바뀜
            const dates = episodes.map((e) => Number(e.dateUpload) || 0).filter((t) => t > 0);
            const latest = dates.length ? Math.max(...dates) : 0;
            let head = `총 ${episodes.length}회`;
            if (latest) {
                const ongoing = Date.now() - latest <= 21 * 86400000;
                status = ongoing ? 0 : 1;
                const k = new Date(latest + 9 * 3600000);
                const pad = (n) => String(n).padStart(2, "0");
                const day = "일월화수목금토"[k.getUTCDay()];
                head = `${ongoing ? "방영 중" : "종영"} · 최근 방영: ${k.getUTCFullYear()}.${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())} (${day}) · ${head}`;
                if (ongoing) name = `${rawName} · ${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())}`;
                else {
                    name = this.titleWithYear(rawName, doc);
                    if (name === rawName && !rawName.includes(String(k.getUTCFullYear()))) name = `${rawName} (${k.getUTCFullYear()})`;
                }
            }
            description = [head, plot].filter((t) => t).join("\n\n");
        }
        return {
            name,
            imageUrl: poster ? this.resolveUrl(`${base}/`, poster.attr("src")) : "",
            description,
            author: doc.select("p.starLink a").map((e) => e.text.trim()).join(", "),
            genre: doc.select(".scroll-content a").map((e) => e.text.trim()).filter((t) => t),
            status,
            link: `${base}${this.toPath(url)}`,
            episodes,
        };
    }

    /** 개봉(방영 시작) 연도를 제목 옆에 표시 - 제목에 이미 연도가 있으면 그대로 */
    titleWithYear(name, doc) {
        const y = doc.selectFirst(".scroll-content a[href*='/year/']");
        const year = y ? y.text.trim() : "";
        return /^(?:19|20)\d{2}$/.test(year) && !name.includes(year) ? `${name} (${year})` : name;
    }

    // ================= 재생 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        const path = this.toPath(url);
        const { html, base } = await this.getPage(path);
        // 같은 회차의 다른 서버 영상 (플레이어에서 바로 바꿀 수 있게 목록 뒤에 붙임).
        // 설정 "다른 서버도 함께 찾기"를 끄면 미리 찾지 않아 재생이 빨리 시작됨 (이 서버가 안 될 때만 찾음)
        const findOthers = async () => {
            try {
                return await this.otherServerVideos(html, path, base);
            } catch (e) {
                return [];
            }
        };
        let wantOthers = false;
        try {
            const v = new SharedPreferences().get("tvchak_other_servers");
            wantOthers = v === true || v === "true";
        } catch (e) {}
        const others = wantOthers ? await findOthers() : [];
        const media = this.mediaOf(html);
        if (!media) {
            // 이 서버가 안 되면 다른 서버 영상이라도
            const fallback = wantOthers ? others : await findOthers();
            if (fallback.length) return fallback;
            throw new Error(`영상 주소를 찾지 못했습니다: ${base}${path}`);
        }
        const q = media.includes(".m3u8") ? "티비착 (HLS)" : "티비착";
        // 먼저 실제로 열리는지 확인해서, 첫 번째 Referer 가 안 되고 대체가 되면 순서를 바꿈 (자동 전환)
        let main = this.videoHeaders(PLAYER_REFERER);
        let alt = this.videoHeaders(`${base}/`);
        if (!(await mediaWorks(this.client, media, main)) && (await mediaWorks(this.client, media, alt))) [main, alt] = [alt, main];
        const list = await hlsExpand(this.client, media, q, main);
        list.push({ url: media, originalUrl: media, quality: `${withRes(q, media)} (대체)`, headers: alt });
        return qualitySort("tvchak_quality", list).concat(others);
    }

    videoHeaders(ref) {
        return { "User-Agent": UA, "Referer": ref, "Origin": ref.replace(/\/$/, "") };
    }

    // 재생 페이지의 player_aaaa 에서 영상 주소 (없으면 글자 안의 영상 주소)
    mediaOf(html) {
        const m = /var\s+player_\w+\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
        let media = null;
        if (m) {
            try {
                const o = JSON.parse(m[1]);
                media = this.decodeUrl(String(o.url || ""), Number(o.encrypt) || 0);
            } catch (e) {
                media = null;
            }
        }
        if (media && MEDIA_RE.test(media)) return media;
        const any = MEDIA_RE.exec(String(html).replace(/\\\//g, "/"));
        return any ? any[0] : null;
    }

    // 재생 페이지에 서버가 여러 개면, 같은 회차(같은 이름)의 다른 서버에서 실제로 열리는 영상을 최대 2개
    async otherServerVideos(html, currentPath, base) {
        const doc = new Document(html);
        const boxes = doc.select("#tagContent .play_list_box");
        const lists = boxes.length ? boxes : doc.select(".content_playlist");
        if (lists.length < 2) return [];
        const tabs = doc.select("#tag .swiper-slide, #tag a").map((e) => e.text.trim());
        const links = [];
        lists.forEach((box, bi) => {
            const server = tabs[bi] || `서버 ${bi + 1}`;
            box.select("a[href*='/vod/play/']").forEach((a) => {
                links.push({ server, label: a.text.trim(), path: this.toPath(a.attr("href")) });
            });
        });
        const cur = links.find((l) => l.path === currentPath);
        if (!cur) return [];
        const seenServer = {};
        const targets = links.filter((l) => l.label === cur.label && l.server !== cur.server && !seenServer[l.server] && (seenServer[l.server] = true))
            .slice(0, 2);
        const out = [];
        for (const t of targets) {
            try {
                const r = await this.getHtml(t.path);
                const media = this.mediaOf(String(r.html || ""));
                if (!media) continue;
                for (const h of [this.videoHeaders(PLAYER_REFERER), this.videoHeaders(`${base}/`)]) {
                    if (await mediaWorks(this.client, media, h)) {
                        const q = media.includes(".m3u8") ? "티비착 (HLS)" : "티비착";
                        out.push({ url: media, originalUrl: media, quality: `${withRes(q, media)} [${t.server}]`, headers: h });
                        break;
                    }
                }
            } catch (e) {
                // 다음 서버
            }
        }
        return out;
    }

    decodeUrl(raw, encrypt) {
        try {
            if (encrypt === 1) return decodeURIComponent(raw);
            if (encrypt === 2) return decodeURIComponent(this.b64(raw));
        } catch (e) {
            return raw;
        }
        return raw;
    }

    b64(s) {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let out = "";
        let bits = 0;
        let val = 0;
        for (const ch of String(s).replace(/[^A-Za-z0-9+/]/g, "")) {
            val = (val << 6) | abc.indexOf(ch);
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((val >> bits) & 0xff);
            }
        }
        return out;
    }

    // ================= 필터 / 설정 =================
    baseFilterList() {
        const sel = (name, param, pairs) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: pairs.map((p) => ({ type_name: "SelectOption", name: p[0], value: p[1] })),
        });
        return [
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용" },
            sel("분류", "type", TYPES),
            sel("정렬", "sort", SORTS),
        ].concat(ruleFilters("tvchak", RULE_SIZES, ["전체 · 인기순", "첫 화면 최신"],
            (i) => `${TYPES[i[0]][0]} · ${SORTS[i[1]][0]}`));
    }

    getFilterList() {
        return statusFilters("tvchak", this.getBaseUrl(), this.autoOn()).concat(this.baseFilterList());
    }

    async getPopular(page) {
        return addrGuard(this, page, () => this.popularGuarded(page));
    }

    async popularGuarded(page) {
        await statusRefresh(this.client);
        const saved = ruleRead("tvchak", true, RULE_SIZES);
        if (saved) return this.withYears(await this.filterPage(page, saved), TYPES[saved[0]][1] === "1");
        return this.withYears(await this.popularBase(page));
    }

    async search(query, page, filters) {
        // 새 주소를 붙여 넣으면 그 주소로 바로 바꿈 (작품 주소면 아래에서 그 작품을, 주소만이면 인기 목록)
        const adopted = await addrAdopt(this, query);
        if (adopted && !/\/(player|vod|content)\//.test(String(query))) return this.getPopular(1);
        await statusRefresh(this.client);
        // 앱이 돌려준 필터에 param 이 빠져 있을 수 있어 같은 이름의 원래 필터에서 채움
        const base = this.baseFilterList();
        const list = (filters || []).filter((f) => f && !f._status && !(f.type_name === "HeaderFilter" && /^(?:📡|🩺|❌|🛡|📝|🎬|📅)/.test(String(f.name || ""))));
        for (const f of list) {
            if (!f.param) {
                const b = base.find((x) => x.name === f.name && x.type_name === f.type_name);
                if (b && b.param) f.param = b.param;
            }
        }
        const typeF = list.find((f) => f.param === "type");
        const isMovie = !query && typeF && TYPES[typeF.state || 0] && TYPES[typeF.state || 0][1] === "1";
        return this.withYears(await this.searchBase(query, page, list), isMovie);
    }

    getSourcePreferences() {
        return [{
            key: "tvchak_domain",
            editTextPreference: {
                title: "티비착 주소 직접 지정 (선택)",
                summary: "비워 두면 자동으로 찾은 주소나 기본 주소(https://tvchak208.com)를 사용합니다.",
                value: "",
                dialogTitle: "티비착 주소",
                dialogMessage: "tvchak숫자.com 또는 비상 주소 tvchak.life 형식의 HTTPS 주소만 사용됩니다.",
            },
        }, {
            key: "tvchak_auto_on",
            switchPreferenceCompat: {
                title: "도메인 자동 찾기",
                summary: "접속이 안 되면 tvchak 번호 주소(현재 번호 -5 ~ +30)를 찾아 자동 변경",
                value: true,
            },
        }, {
            key: "tvchak_other_servers",
            switchPreferenceCompat: {
                title: "다른 서버도 함께 찾기",
                summary: "켜면 재생 목록에 다른 서버 영상([서버 이름])도 붙임. 끄면 미리 찾지 않아 재생이 더 빨리 시작 (지금 서버가 안 될 때만 찾음)",
                value: false,
            },
        }, qualityPreference("tvchak_quality")];
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
        return t.startsWith("/") ? origin + t : origin + "/" + t;
    }
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
    await notesRefresh(client);
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
    return lines.map((name) => ({ type_name: "HeaderFilter", name, _status: true })).concat(notesFilters(key));
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
