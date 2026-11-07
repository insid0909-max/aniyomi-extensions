const mangayomiSources = [{
    "name": "미미티비",
    "lang": "ko",
    "baseUrl": "https://mimitv12.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.7",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/mimitv.js"
}];

// 미미티비 (mimitv12.com, 2026-11-05, 해외에서도 열려 실제 구조 확인 후 만듦. 예전 애니요미 MimiTV.kt 와 같은 구조)
// 목록 /show.php?tid=분류&class=장르&order_type=(빈 값 최신|vod_hits 인기)&limit=24&page=N, 카드 div.item(a.poster img data-src, h3 a.title, 툴팁 연도)
// 검색 /search.php?keyword=, 작품 /shplay.php?id=N (h1.entry-title, .desc, .meta 국가·장르·연도·감독·배우)
// 회차는 작품 화면 글자 안 manualSeasons = [{"e":[{"link_1","host_1":"제1화",...}]}] (작품마다 최신이 위이거나 1화가 위), 회차 날짜는 사이트에 없음
// 재생: 플레이어(xiaoca.top/one/onet.php?url=…)의 url= 주소는 가짜(404). 진짜 주소는 플레이어가 스스로 풀어 요청 →
// 숨은 웹뷰로 플레이어를 그대로 열고 플레이어가 요청한 /hls/….m3u8 주소를 돌려받음 (암호를 확장이 직접 풀지 않음). 영상은 Referer=플레이어 주소 필요
const DEFAULT_BASE_URL = "https://mimitv12.com";
const DOMAIN_RE = /^https:\/\/(?:www\.)?mimitv\d+\.com$/;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
// 진짜 사이트 화면마다 있는 글자 (작품 링크)
const MARK = "shplay.php";

const CATEGORIES = [
    ["전체", ""], ["영화", "1"], ["한국영화", "40"], ["해외영화", "41"], ["드라마", "2"], ["한국드라마", "42"],
    ["해외드라마", "43"], ["숏드라마", "44"], ["예능", "3"], ["시사다큐", "4"], ["애니", "5"],
];
const MOVIE_TIDS = ["1", "40", "41"];
const GENRES = [
    "전체", "스릴러", "액션", "범죄", "코미디", "로맨스", "공포", "미스터리", "다큐멘터리", "서사",
    "SF", "판타지", "가족", "전쟁", "모험", "웹드라마", "요리", "시상식", "버라이어티", "공연",
];
const SORTS = [["최신순", ""], ["인기순", "vod_hits"]];
const RULE_SIZES = [CATEGORIES.length, GENRES.length, SORTS.length];
// 기본: 인기 = 드라마 인기순, 최신 = 드라마 최신순
const DEFAULT_POPULAR = [4, 0, 1];
const DEFAULT_LATEST = [4, 0, 0];
// 장르에 방송 요일(일일·주말·금요 등)이 있으면 방영 중
const AIRING_RE = /월화|수목|금토|토일|일일|주말|매일|월요|화요|수요|목요|금요|토요|일요/;

// ---------- 접속 속도 제한 · 화질 나누기 ----------
// 사이트로 가는 요청 사이에 최소 간격 (한꺼번에 많이 요청하면 사이트가 403으로 막음)
let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// HLS 마스터 목록에 화질이 여러 개면 각각 따로 고를 수 있게 나눔. 하나뿐이거나 읽지 못하면 그대로
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
const ADDR_HOST = /^(?:www\.)?mimitv\d+\.com$/;
const ADDR_MARK = MARK;
const ADDR_UA = UA;
const ADDR_PREF = "mimitv_domain";


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

    // 직접 지정한 주소 > 자동으로 찾은 주소 > 기본 주소
    getBaseUrl() {
        let custom = "";
        let auto = "";
        try {
            const p = new SharedPreferences();
            custom = (p.get("mimitv_domain") || "").trim().replace(/\/+$/, "");
            auto = (p.getString("mimitv_auto_domain", "") || "").trim();
        } catch (e) {
            custom = "";
        }
        const num = (u) => parseInt((/mimitv(\d+)\./.exec(String(u)) || [0, "0"])[1], 10) || 0;
        if (custom && !/^https?:\/\//.test(custom)) custom = "https://" + custom;
        if (DOMAIN_RE.test(custom)) {
            // 직접 넣은 주소는 바로 씀. 단 자동 찾기로 그보다 번호가 큰 진짜 사이트 주소가 확인되면 그 주소로 바꾸고 설정 칸도 고침
            if (DOMAIN_RE.test(auto) && auto !== custom && num(auto) > num(custom) && this.autoOn()) {
                try {
                    new SharedPreferences().setString("mimitv_domain", auto);
                } catch (e) {
                    // 저장 실패는 무시 (이번 요청은 새 주소로)
                }
                return auto;
            }
            return custom;
        }
        // 자동으로 찾은 주소가 확장 업데이트로 바뀐 기본 주소보다 옛 번호면 기본 주소를 씀
        return DOMAIN_RE.test(auto) && num(auto) >= num(DEFAULT_BASE_URL) ? auto : DEFAULT_BASE_URL;
    }

    autoOn() {
        try {
            const v = new SharedPreferences().get("mimitv_auto_on");
            return v !== false && v !== "false";
        } catch (e) {
            return true;
        }
    }

    // 저장소 주소 목록 → mimitvN.com (지금 번호 -3 ~ +20) 중 진짜 미미티비인 가장 큰 번호 (1분에 한 번만)
    async discover(current) {
        const p = new SharedPreferences();
        const last = Number(p.getString("mimitv_auto_at", "0")) || 0;
        if (Date.now() - last < 60000) return null;
        p.setString("mimitv_auto_at", String(Date.now()));
        const num = (u) => parseInt((/mimitv(\d+)\./.exec(String(u)) || [0, "0"])[1], 10) || 0;
        const real = async (c) => {
            try {
                const r = await this.client.get(c + "/", { "User-Agent": UA });
                const b = String(r.body || "");
                return r.statusCode === 200 && b.indexOf(MARK) >= 0 && b.indexOf("미미티비") >= 0 ? c : null;
            } catch (e) {
                return null;
            }
        };
        // 저장소 주소 목록 파일(domains.json)에 적힌 주소 먼저 (진짜 사이트일 때만)
        const listed = await listedDomain(this.client, "mimitv");
        if (listed && listed !== current && DOMAIN_RE.test(listed) && await real(listed)) {
            p.setString("mimitv_auto_domain", listed);
            return listed;
        }
        const cur = num(current) || num(DEFAULT_BASE_URL);
        const cands = [];
        for (let i = Math.max(1, cur - 3); i <= cur + 20; i++) {
            const c = `https://mimitv${i}.com`;
            if (c !== current) cands.push(c);
        }
        const ok = (await Promise.all(cands.map(real))).filter((x) => x).sort((a, b) => num(b) - num(a));
        const found = ok[0] || null;
        if (found) p.setString("mimitv_auto_domain", found);
        return found;
    }

    headers(referer) {
        return { "User-Agent": UA, "Referer": referer || `${this.getBaseUrl()}/` };
    }

    // 사이트 화면 글자. 접속이 안 되면(오류·5xx·451) 새 주소를 찾아 다시 요청
    async getHtml(path) {
        const base = this.getBaseUrl();
        // 예전 주소가 통째로 저장된 작품(서재 등)은 지금 주소로 바꿔서 엶
        path = String(path || "").replace(/^https?:\/\/(?:www\.)?mimitv\d+\.com(?=\/)/i, "");
        if (!path.startsWith("/") && !path.startsWith("http")) path = "/" + path;
        const url = path.startsWith("http") ? path : base + path;
        const ours = url.startsWith(base);
        await siteWait();
        let res = null;
        let notice = null;
        try {
            res = await this.client.get(url, this.headers());
            const code = Number(res.statusCode);
            if (!ours || !(code >= 500 || code === 451)) {
                notice = ours && code === 200 && this.autoOn() ? await noticeTarget(this, res.body, base, MARK) : null;
                if (!notice) return { html: String(res.body || ""), base, code };
            }
        } catch (e) {
            if (!ours) throw e;
            res = null;
        }
        const found = notice || (this.autoOn() ? await this.discover(base) : null);
        if (notice) new SharedPreferences().setString("mimitv_auto_domain", notice);
        if (!found) {
            if (res) return { html: String(res.body || ""), base, code: Number(res.statusCode) };
            throw new Error(`접속 실패: ${url}`);
        }
        await siteWait();
        const r2 = await this.client.get(found + url.substring(base.length), this.headers(`${found}/`));
        return { html: String(r2.body || ""), base: found, code: Number(r2.statusCode) };
    }

    // ================= 목록 =================
    listPath(idx, page) {
        const tid = CATEGORIES[idx[0]][1];
        const params = [];
        if (tid) params.push(`tid=${tid}`);
        if (idx[1] > 0) params.push(`class=${encodeURIComponent(GENRES[idx[1]])}`);
        params.push(`order_type=${SORTS[idx[2]][1]}`);
        if (page > 1) params.push(`limit=24&page=${page}`);
        return `/show.php?${params.join("&")}`;
    }

    async filterPage(page, idx) {
        const { html, base } = await this.getHtml(this.listPath(idx, page));
        return this.parseList(html, base, MOVIE_TIDS.includes(CATEGORIES[idx[0]][1]));
    }

    async popularBase(page) {
        return this.filterPage(page, ruleRead("mimitv", true, RULE_SIZES) || DEFAULT_POPULAR);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return addrGuard(this, page, () => this.filterPage(page, ruleRead("mimitv", false, RULE_SIZES) || DEFAULT_LATEST));
    }

    async searchBase(query, page, filters) {
        // 작품 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
        const byUrl = /shplay\.php\?id=(\d+)/.exec(String(query || ""));
        if (byUrl) {
            const link = `/shplay.php?id=${byUrl[1]}`;
            const d = await this.getDetail(link);
            return { list: d.name ? [{ name: d.name, imageUrl: d.imageUrl, link }] : [], hasNextPage: false };
        }
        const q = String(query || "").trim();
        if (q) {
            const { html, base } = await this.getHtml(`/search.php?keyword=${encodeURIComponent(q)}${page > 1 ? `&limit=24&page=${page}` : ""}`);
            return this.parseList(html, base, false);
        }
        const pick = (name) => {
            const f = (filters || []).find((x) => x && x.name === name);
            return (f && f.state) || 0;
        };
        const idx = [pick("분류"), pick("장르"), pick("정렬")];
        ruleApply("mimitv", pick(RULE_NAME), idx);
        return this.filterPage(page, idx);
    }

    unesc(t) {
        return String(t || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    }

    text(html) {
        return this.unesc(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    }

    abs(base, u) {
        const t = String(u || "").trim();
        if (!t || /^data:/i.test(t)) return "";
        if (/^https?:\/\//.test(t)) return t;
        if (t.startsWith("//")) return "https:" + t;
        return base + (t.startsWith("/") ? "" : "/") + t;
    }

    /** 목록·검색 공통: 작품 카드 div.item. 영화 분류면 제목 뒤에 (연도) */
    parseList(html, base, movie) {
        const list = [];
        const seen = {};
        const re = /<div id="post-\d+" class="item[^"]*"[\s\S]*?(?=<div id="post-\d+" class="item|<div class="pagenav"|$)/g;
        let m;
        while ((m = re.exec(html))) {
            const card = m[0];
            const id = (/shplay\.php\?id=(\d+)/.exec(card) || [])[1];
            if (!id || seen[id]) continue;
            seen[id] = true;
            const img = /<img\b[^>]*>/.exec(card);
            const attr = (k) => { const x = img ? new RegExp(`\\s${k}="([^"]*)"`).exec(img[0]) : null; return x ? x[1] : ""; };
            const t = /<a class="title"[^>]*>([\s\S]*?)<\/a>/.exec(card);
            const name = (t ? this.text(t[1]) : "") || this.unesc(attr("alt")).trim();
            if (!name) continue;
            const year = (/<div class="meta">\s*(?:<!--[\s\S]*?-->\s*)?<span>\s*((?:19|20)\d{2})\s*<\/span>/.exec(card) || [])[1];
            list.push({
                name: movie && year && !/\((?:19|20)\d{2}\)\s*$/.test(name) ? `${name} (${year})` : name,
                imageUrl: this.abs(base, attr("data-src") || attr("src")),
                link: `/shplay.php?id=${id}`,
            });
        }
        // 다음 쪽: 지금 쪽(li.active) 뒤에 쪽 번호 링크가 더 있으면
        const pag = /<ul class='pagination'>([\s\S]*?)<\/ul>/.exec(html);
        let hasNextPage = false;
        if (pag) {
            const after = pag[1].split(/<li class="active">/)[1] || "";
            // 쪽 번호는 10개씩 묶음 → 10·20쪽 뒤에는 숫자 대신 "다음" 링크 (2026-11-06, 전엔 10쪽·240개에서 멈춤)
            hasNextPage = /<a\s+href="[^"]*page=\d+"[^>]*>\s*(?:\d+|다음)\s*<\/a>/.test(after);
        }
        // 인기순은 사이트가 4~5쪽(약 95개)까지만 주고 뒤는 빈 쪽 → 빈 쪽이면 끝
        return { list, hasNextPage: hasNextPage && list.length > 0 };
    }

    // ================= 상세 / 회차 =================
    seasonsOf(html) {
        const m = /manualSeasons\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
        if (!m) return [];
        try {
            return JSON.parse(m[1]).map((s) => (s && Array.isArray(s.e) ? s.e : []).map((o) => ({
                label: String((o && o.host_1) || "").replace(/\s+/g, " ").trim(),
                links: [1, 2, 3].map((k) => String((o && o[`link_${k}`]) || "").trim()).filter((u) => /^https?:\/\//.test(u)),
            })));
        } catch (e) {
            return [];
        }
    }

    meta(html, key) {
        const m = new RegExp(`<span>\\s*${key}\\s*:?\\s*</span>\\s*<span>([\\s\\S]*?)</span>`).exec(html);
        return m ? this.text(m[1]) : "";
    }

    async getDetail(url) {
        const id = (/id=(\d+)/.exec(String(url)) || [0, ""])[1];
        const link = `/shplay.php?id=${id}`;
        const { html, base } = await this.getHtml(link);
        const tm = /<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/.exec(html);
        const rawName = tm ? this.text(tm[1]) : "";
        const info = (/<section id="post-\d+" class="info[\s\S]*?<\/section>/.exec(html) || [html])[0];
        const poster = /<div class="poster">[\s\S]*?<img\b[^>]*\sdata-src="([^"]+)"/.exec(info) || /<div class="poster">[\s\S]*?<img\b[^>]*\ssrc="(http[^"]+)"/.exec(info);
        const desc = /<div class="desc[^"]*">([\s\S]*?)<\/div>/.exec(info);
        const genres = this.meta(info, "장르");
        const year = (/(?:19|20)\d{2}/.exec(this.meta(info, "연도")) || [""])[0];
        const seasons = this.seasonsOf(html);
        const total = seasons.reduce((a, s) => a + s.length, 0);
        const isMovie = /영화/.test(genres) || (total === 1 && !/\d+\s*화/.test((seasons[0] && seasons[0][0] && seasons[0][0].label) || ""));
        const episodes = this.episodes(id, seasons, isMovie);
        // 회차에 방송 날짜가 있으면(가요무대 등) 최근 방영일로 방영 중(3주 안)/끝남을 판단
        const latest = Math.max(0, ...episodes.map((e) => Number(e.dateUpload) || 0));
        const recent = latest > 0 && Date.now() - latest <= 21 * 86400000;
        const airing = !isMovie && (latest ? recent : AIRING_RE.test(genres));
        const status = isMovie ? 1 : airing ? 0 : latest ? 1 : 5;
        const kst = latest ? new Date(latest + 9 * 3600000) : null;
        const pad2 = (n) => String(n).padStart(2, "0");
        const yearRe = /\s*\((?:19|20)\d{2}\)\s*$/;
        // 끝났거나 방영 여부를 모르는 작품은 제목 뒤에 (연도). 방영 중은 회차 날짜가 없어 그대로
        // 방영 중이면 제목 뒤에 최근 방영일 " · MM.dd"(날짜가 있을 때, 망가요미는 서재 제목도 갱신), 아니면 (연도)
        const name = airing && kst ? `${rawName.replace(yearRe, "")} · ${pad2(kst.getUTCMonth() + 1)}.${pad2(kst.getUTCDate())}`
            : !airing && year && rawName && !yearRe.test(rawName) ? `${rawName} (${year})` : rawName;
        const lines = [];
        if (kst) {
            const day = "일월화수목금토"[kst.getUTCDay()];
            lines.push(`${airing ? "방영 중 · " : "종영 · "}최근 방영: ${kst.getUTCFullYear()}.${pad2(kst.getUTCMonth() + 1)}.${pad2(kst.getUTCDate())} (${day})`);
        } else if (airing) lines.push("방영 중");
        for (const k of ["국가", "장르", "연도", "감독", "배우"]) {
            const v = this.meta(info, k);
            if (v) lines.push(`${k}: ${v}`);
        }
        if (desc) lines.push(this.text(desc[1]));
        return {
            name,
            imageUrl: poster ? this.abs(base, poster[1]) : "",
            description: lines.join("\n"),
            author: this.meta(info, "감독"),
            genre: genres.split(",").map((g) => g.trim()).filter((g) => g),
            status,
            link: base + link,
            episodes,
        };
    }

    /**
     * 회차: 이름은 번호로 시작("12화", 번호 없는 "특 집" 은 앞 회차 번호 + 0.5), 여러 시즌이면 scanlator 에 "시즌N".
     * 사이트 순서가 작품마다 달라(최신이 위 / 1화가 위) 번호로 방향을 보고 최신이 위로 오게
     */
    /** 회차 이름이 날짜면 {at: 한국시간 그날 0시, short: "26.10.19"} ("26-10-19"·"2026-10-19"·"26.10.19") */
    labelDate(label) {
        const m = /^\s*(\d{2}|\d{4})[-./](\d{1,2})[-./](\d{1,2})\s*$/.exec(String(label || ""));
        if (!m) return null;
        const y = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const pad = (n) => String(n).padStart(2, "0");
        return { at: Date.UTC(y, mo - 1, d) - 9 * 3600000, short: `${String(y).substring(2)}.${pad(mo)}.${pad(d)}` };
    }

    episodes(id, seasons, isMovie) {
        const out = [];
        const multi = seasons.length > 1;
        seasons.forEach((eps, s) => {
            const nums = eps.map((e) => { const m = /(\d+(?:\.\d+)?)\s*화/.exec(e.label); return m ? parseFloat(m[1]) : null; });
            const dates = eps.map((e) => this.labelDate(e.label));
            const known = nums.filter((n) => n !== null);
            const dated = dates.filter((d) => d);
            // 회차 이름이 방송 날짜("26-10-19", 가요무대 등)면 날짜로, 아니면 번호로 방향을 봄 → 과거 → 최신 차례
            const byDate = !known.length && dated.length >= Math.max(1, eps.length / 2);
            const newestFirst = byDate ? dated.length >= 2 && dated[0] > dated[dated.length - 1]
                : known.length >= 2 && known[0] > known[known.length - 1];
            const order = eps.map((e, i) => i);
            if (newestFirst) order.reverse();
            // 번호 없는 회차가 10개 넘게 이어지면 "앞 번호 + 0.5" 로는 번호가 겹침 → 차례 번호로
            let run = 0;
            let longRun = false;
            for (const i of order) { run = nums[i] === null ? run + 1 : 0; if (run > 9) longRun = true; }
            const seqMode = byDate || (longRun && eps.length > 1);
            let last = 0;
            let step = 0;
            const part = [];
            order.forEach((i, k) => {
                const e = eps[i];
                let name;
                if (seqMode) {
                    // 사이트에 회차 번호가 없어 오래된 회차부터 센 차례 번호 + 날짜(있으면)
                    const d = dates[i];
                    name = d ? `${k + 1}회 (${d.short})` : `${k + 1}회 ${e.label.replace(/\s+/g, " ")}`.trim();
                } else if (nums[i] !== null) {
                    last = nums[i];
                    step = 0;
                    const rest = e.label.replace(/^제?\s*0*\d+(?:\.\d+)?\s*화\s*/, "").trim();
                    name = `${nums[i]}화${rest ? " " + rest : ""}`;
                } else if (eps.length === 1 && seasons.length === 1) {
                    name = isMovie ? "본편" : (e.label || "본편");
                } else {
                    step = Math.min(step + 1, 9);
                    const n = Math.round((last + 0.5 + (step - 1) / 10) * 10) / 10;
                    name = `${n} ${e.label.replace(/\s+/g, "") || "특별편"}`;
                }
                part.push({
                    name, url: `/shplay.php?id=${id}&ep=${s}_${i}`,
                    dateUpload: dates[i] ? String(dates[i].at) : null,
                    scanlator: multi ? `시즌${s + 1}` : "",
                });
            });
            part.reverse().forEach((x) => out.push(x));
        });
        // 시즌도 최신 시즌이 위로
        if (multi) {
            const by = {};
            out.forEach((x) => (by[x.scanlator] = by[x.scanlator] || []).push(x));
            return Object.keys(by).sort((a, b) => parseInt(b.replace(/\D/g, ""), 10) - parseInt(a.replace(/\D/g, ""), 10))
                .reduce((a, k) => a.concat(by[k]), []);
        }
        return out;
    }

    // ================= 재생 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        const ep = /ep=(\d+)_(\d+)/.exec(String(url));
        const id = (/id=(\d+)/.exec(String(url)) || [0, ""])[1];
        const { html, base } = await this.getHtml(`/shplay.php?id=${id}`);
        const seasons = this.seasonsOf(html);
        const e = ep && seasons[Number(ep[1])] ? seasons[Number(ep[1])][Number(ep[2])] : null;
        if (!e) throw new Error("회차 정보를 찾지 못했어요. 회차 목록을 아래로 당겨 새로고침해 주세요");
        if (!e.links.length) throw new Error("이 회차에는 재생 주소가 없어요");
        const fails = [];
        const out = [];
        for (let i = 0; i < e.links.length; i++) {
            const player = e.links[i];
            const media = await this.viaWebview(player, `${base}/`, fails);
            if (!media) continue;
            const origin = (/^(https?:\/\/[^/]+)/.exec(player) || [null, ""])[1];
            const headers = { "User-Agent": UA, "Referer": origin + "/", "Origin": origin };
            const label = out.length ? `미미티비 (대체 ${out.length})` : "미미티비";
            const list = await hlsExpand(this.client, media, label, headers);
            if (!out.length) qualitySort("mimitv_quality", list).forEach((v) => out.push(v));
            else out.push(list[0]);
            break;
        }
        if (!out.length) {
            const wv = typeof evaluateJavascriptViaWebview === "function" ? "" : " · 웹뷰 미지원";
            throw new Error(`영상 주소를 찾지 못했어요. 잠시 뒤 다시 시도해 주세요 [${fails.join(", ") || "플레이어"}${wv}]`);
        }
        return out;
    }

    /** 숨은 웹뷰로 플레이어를 열고, 플레이어가 요청한 m3u8 주소를 돌려받음 (최대 20초) */
    async viaWebview(player, referer, fails) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        const script = "(function(){var n=0;function find(){var r=performance.getEntriesByType('resource');" +
            "for(var i=0;i<r.length;i++){var u=r[i].name;if(/\\.m3u8(\\?|$)/.test(u)&&u.indexOf('onet.php')<0)return u;}return null;}" +
            "var t=setInterval(function(){n++;var u=find();" +
            "if(u){clearInterval(t);window.flutter_inappwebview.callHandler('setResponse',u);return;}" +
            "if(n===20){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.art-state,.art-control-play');if(b)b.click();}},300);})();";
        try {
            const timeout = new Promise((res) => setTimeout(() => res(null), 20000));
            const res = await Promise.race([evaluateJavascriptViaWebview(player, { "Referer": referer }, [script]), timeout]);
            if (res && /^https?:\/\//.test(String(res))) return String(res);
            fails.push("웹뷰에서 못 찾음");
        } catch (e) {
            fails.push("웹뷰 오류 " + String((e && e.message) || e).substring(0, 40));
        }
        return null;
    }

    // ================= 필터 / 설정 =================
    baseFilterList() {
        const select = (name, items) => ({
            type_name: "SelectFilter", name, state: 0,
            values: items.map((label, i) => ({ type_name: "SelectOption", name: label, value: String(i) })),
        });
        const text = (i) => [CATEGORIES[i[0]][0], i[1] > 0 ? GENRES[i[1]] : "", SORTS[i[2]][0]].filter((x) => x).join(" · ");
        const cat = select("분류", CATEGORIES.map((c) => c[0]));
        cat.state = DEFAULT_LATEST[0];
        return [
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)" },
            cat,
            select("장르", GENRES),
            select("정렬", SORTS.map((s) => s[0])),
        ].concat(ruleFilters("mimitv", RULE_SIZES, [text(DEFAULT_POPULAR), text(DEFAULT_LATEST)], text));
    }

    statusBase() {
        try {
            return this.getBaseUrl();
        } catch (e) {
            return this.source.baseUrl;
        }
    }

    statusAuto() {
        try {
            return this.autoOn();
        } catch (e) {
            return null;
        }
    }

    getFilterList() {
        return statusFilters("mimitv", this.statusBase(), this.statusAuto()).concat(this.baseFilterList());
    }

    async getPopular(page) {
        return addrGuard(this, page, async () => {
            await statusRefresh(this.client);
            return this.popularBase(page);
        });
    }

    async search(query, page, filters) {
        // 새 주소를 붙여 넣으면 그 주소로 바로 바꿈 (작품 주소면 아래에서 그 작품을, 주소만이면 인기 목록)
        const adopted = await addrAdopt(this, query);
        if (adopted && !/shplay\.php/.test(String(query))) return this.getPopular(1);
        await statusRefresh(this.client);
        // 맨 위 상태 줄은 빼고 넘김. 망가요미는 _status 표시를 지워서 돌려주므로 글자로도 거름
        return this.searchBase(query, page, (filters || []).filter((f) => f && !f._status && !(f.type_name === "HeaderFilter" && /^(?:📡|🩺|❌|🛡|📝)/.test(String(f.name || "")))));
    }

    getSourcePreferences() {
        return [{
            key: "mimitv_domain",
            editTextPreference: {
                title: "미미티비 주소 직접 지정 (선택)",
                summary: "비워 두면 자동으로 찾은 주소나 기본 주소(https://mimitv12.com)를 사용합니다.",
                value: "",
                dialogTitle: "미미티비 주소",
                dialogMessage: "mimitv숫자.com 형식의 주소 (예: https://mimitv12.com)",
            },
        }, {
            key: "mimitv_auto_on",
            switchPreferenceCompat: {
                title: "도메인 자동 찾기",
                summary: "접속이 안 되면 mimitv 번호 주소(현재 번호 -3 ~ +20) 중 열리는 주소로 자동 변경",
                value: true,
            },
        }, qualityPreference("mimitv_quality")];
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
// 확장마다 영화 회차가 "바로보기"·"한글자막"·"1회 · 바로보기"·"애니감상"·"1. 극장판 X" 처럼 달라서 → "1. 본편" 으로 (애니요미는 "본편").
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
