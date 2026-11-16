// [시험] 2026-11-16 다시 만듦: 10-22 에 지운 마루마루 코드(웹툰 저장소 #71) + 웹툰 망가요미 공통 기능(📝 버전·필터 빈 줄·빠진 회차·검색 띄어쓰기·회차 겹침 막기), 주소 marumaru111
const mangayomiSources = [{
    "id": 1543279651,
    "name": "[시험] 마루마루 웹툰",
    "lang": "ko",
    "baseUrl": "https://marumaru111.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/icon/eu.kanade.tachiyomi.extension.ko.newxtoon.png",
    "typeSource": "single",
    "itemType": 0,
    "isNsfw": true,
    "hasCloudflare": false,
    "version": "0.0.1",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "marumaru_webtoon.js"
}];

const MEDIA = "WEBTOON";
const SECTION = MEDIA === "MANHWA" ? "manhwa" : MEDIA === "NOVEL" ? "novel" : "webtoon";
// 감시 점검 결과 이름 (필터 맨 위 🩺 줄)
const STATUS_KEY = MEDIA === "WEBTOON" ? "marumaru" : "marumaru_" + SECTION;

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const AUTO_HOST = /^(?:www\.)?marumaru\d+\.[a-z]{2,6}$/;
const AUTO_NUM = /marumaru(\d+)/;
// 진짜 사이트 첫 화면에만 있는 글자 (로고 그림 주소)
const MARK = "<title>마루마루"; // 2026-11-16: 예전 로고 주소가 첫 화면에서 빠져 제목으로
const READER = "https://api.storagewebtoon.store/api/v1/reader/A2";
const PAGE_SIZE = 49;
const PAID_MSG = "이 회차는 사이트에서 포인트로 사야 볼 수 있어요 (확장으로는 볼 수 없음)";

const opts = (names) => [["전체", ""]].concat(names.map((n) => [n, n]));
const WEBTOON_CATEGORIES = [["일반 (BL/GL 제외)", ""], ["전체", "ALL"], ["BL/GL", "BLGL"], ["성인", "ADULT"]];
const CATEGORIES = [["전체", ""], ["BL/GL", "BLGL"], ["성인", "ADULT"]];
const STATUSES = [["전체", ""], ["완결", "completed"], ["연재 중 (검색만)", "ongoing"]];
const SORTS = [["최신순", "LATEST"], ["신작순", "NEW"], ["북마크순", "BOOKMARK"], ["조회순", "VIEW"], ["평점순", "RATING"], ["화수순", "EPISODE"]];
const SEARCH_SORTS = ["LATEST", "BOOKMARK", "VIEW", "EPISODE"];
const WEEKDAYS = [["전체", ""], ["월", "MON"], ["화", "TUE"], ["수", "WED"], ["목", "THU"], ["금", "FRI"], ["토", "SAT"], ["일", "SUN"]];
const WEBTOON_PLATFORMS = ["네이버", "카카오", "레진", "투믹스", "탑툰", "코미카", "배틀코믹스", "케이툰", "피너툰", "봄툰", "코미코", "리디북스", "기타"];
const MANHWA_PLATFORMS = ["네이버", "카카오", "레진", "투믹스", "탑툰", "코미카", "배틀코믹스", "코믹GT", "케이툰", "애니툰", "폭스툰", "피너툰", "봄툰", "코미코", "무툰", "리디북스", "기타"];
const WEBTOON_GENRES = ["판타지", "액션", "미스터리", "로맨스", "드라마", "무협", "스포츠", "일상", "학원", "성인", "개그", "연애", "추리", "공포", "옴니버스", "에피소드", "소년", "기타", "고수위"];
const MANHWA_GENRES = ["순정", "판타지", "러브코미디", "드라마", "17", "학원", "라노벨", "개그", "액션", "백합", "일상", "SF", "이세계", "스릴러", "애니화", "전생", "스포츠", "TS", "소년", "먹방", "붕탁", "게임", "호러", "시대", "로맨스", "추리", "음악", "무협", "BL", "스토리", "BL/백합", "성인", "연애", "공포", "옴니버스", "에피소드", "기타", "고수위"];
const NOVEL_GENRES = ["판타지", "무협", "19금", "현대", "로맨스", "로맨스 판타지", "BL", "라노벨", "기타"];
const INITIALS = ["ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅅ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const WEEKDAY_NAMES = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };

// 마루마루 (marumaru###.com) - 화면은 React 앱이고 목록·작품은 사이트의 /api/works, 회차·본문은 api.storagewebtoon.store 에서 JSON 으로 받음.
// 웹툰·만화·소설 파일은 같은 코드 (맨 위 이름·id·pkgPath·itemType 과 MEDIA 만 다름)

// ---------- 인기/최신 탭 규칙 ----------
const TAB_RULE_NAME = "인기/최신 탭 규칙";
const TAB_KEY_POPULAR = "tab_rule_popular";
const TAB_KEY_LATEST = "tab_rule_latest";
const TAB_RULE_OPTIONS = [
    "저장하지 않음 (필터 결과만 보기)",
    "현재 조건을 인기 탭에 저장",
    "현재 조건을 최신 탭에 저장",
    "인기 탭을 기본값으로 복원",
    "최신 탭을 기본값으로 복원",
    "두 탭 모두 기본값으로 복원"
];

// ---------- 접속 속도 제한 · 주소로 바로 열기 ----------
// 사이트로 가는 요청 사이에 최소 간격 (한꺼번에 많이 요청하면 사이트가 403으로 막음). 그림 요청은 제외
let lastSiteRequest = 0;
async function siteWait(url) {
    const m = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(String(url || ""));
    if (!m || !AUTO_HOST.test(m[1]) || /\.(?:jpe?g|png|webp|gif|avif|bmp)$/i.test(m[2])) return;
    const wait = lastSiteRequest + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

// 검색창에 사이트 작품(또는 회차) 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
async function openByUrl(ext, query, toLink) {
    // 새 주소를 붙여 넣으면 그 주소로 바로 바꿈 (주소만이면 인기 목록)
    const adopted = await addrAdopt(ext, query);
    const m = /^(?:https?:\/\/)?([^/?#\s]+)(\/[^#\s]*)?$/.exec(String(query || "").trim());
    if (!m || !AUTO_HOST.test(m[1].toLowerCase())) return null;
    const link = toLink(m[2] || "/");
    if (!link) return adopted ? await ext.getPopular(1) : null;
    const d = await ext.getDetail(link);
    return { list: d && d.name ? [{ name: d.name, imageUrl: d.imageUrl || "", link }] : [], hasNextPage: false };
}

// 옛 주소가 끊기지 않고 "접속 주소 안내" 페이지(새 주소 링크만 있는 작은 페이지)를 보여 주면,
// 거기 적힌 더 큰 번호의 같은 사이트 주소 중 진짜 사이트(marker 가 보임)를 돌려줌
async function noticeTarget(ext, body, base, marker) {
    body = String(body || "");
    if (!body || body.length >= 30000 || body.indexOf(marker) >= 0) return null;
    if (!/<html|<!doctype/i.test(body.substring(0, 3000))) return null; // JSON·API 응답은 제외
    return familyTarget(ext, body, base, marker, false);
}

// 정상 사이트 화면에 지금보다 번호가 큰 같은 사이트 주소가 적혀 있으면(사이트 자기 주소·새 주소 안내),
// 진짜 사이트인지 확인해 그 주소를 돌려줌 → 옛 주소가 새 주소로 넘겨 줘도 새 주소를 기억 (망가요미는 넘어간 주소를 알려 주지 않음)
const FAMILY_TRIED = {};
async function selfTarget(ext, body, base, marker) {
    body = String(body || "");
    if (!body || body.indexOf(marker) < 0) return null;
    return familyTarget(ext, body, base, marker, true);
}

async function familyTarget(ext, body, base, marker, quiet) {
    const host = base.replace(/^https?:\/\//, "");
    const h = host.replace(/^www\./, "");
    const head = h.substring(0, h.lastIndexOf("."));
    const m = /(\d+)(?!.*\d)/.exec(head);
    if (!m) return null;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:www\\.)?${esc(head.substring(0, m.index))}\\d+${esc(head.substring(m.index + m[1].length))}\\.[a-z]{2,6}`, "gi");
    const num = (s) => {
        const x = /(\d+)(?!.*\d)/.exec(s.replace(/^www\./, "").replace(/\.[a-z]{2,6}$/i, ""));
        return x ? parseInt(x[1], 10) : 0;
    };
    const cur = parseInt(m[1], 10);
    const cands = [...new Set((body.match(re) || []).map((x) => x.toLowerCase()))]
        .filter((x) => AUTO_HOST.test(x) && num(x) > cur).sort((a, b) => num(b) - num(a));
    for (const c of cands.slice(0, 3)) {
        // 확인에 실패한 주소는 30분 동안 다시 열어 보지 않음 (정상 화면마다 확인하므로)
        if (quiet && Date.now() - (FAMILY_TRIED[c] || 0) < 30 * 60000) continue;
        if (quiet) FAMILY_TRIED[c] = Date.now();
        for (const hh of host.startsWith("www.") && !c.startsWith("www.") ? [c, "www." + c] : [c]) {
            try {
                const r = await ext.client.get(`https://${hh}/`, { "User-Agent": MOBILE_UA });
                if (r.statusCode === 200 && String(r.body || "").indexOf(marker) >= 0) return `https://${hh}`;
            } catch (e) {}
        }
    }
    return null;
}

// 회차 이름 끝에 남은 화 수를 붙임 ("112화 · 남은 26화", 마지막 화는 "112화 · 마지막"). list: 최신 → 과거
// 읽는 화면 제목이 잘리지 않게 사이트 순번("0112 - ")과 맨 앞 작품 제목은 뺌. 설정 "회차 이름에 남은 화 표시"로 끌 수 있음
function chapterPosition(list, title) {
    try {
        const v = new SharedPreferences().get("chapter_position");
        if (v === false || v === "false") return list;
    } catch (e) {}
    const t = String(title || "").trim();
    return list.map((c, i) => {
        // 정렬이 붙인 앞 번호("65 · ")는 두고 그 뒤에서 사이트 순번·작품 제목을 뺌
        const lead = (/^\d+(?:\.\d+)? · /.exec(String(c.name || "").trim()) || [""])[0];
        let n = String(c.name || "").trim().substring(lead.length).replace(/^\d{2,}(?:\s+[-–.:)\]]|[-–.:)\]]\s)\s*/, "");
        if (t && n.startsWith(t)) {
            const rest = n.substring(t.length).replace(/^[\s\-–:·.]+/, "");
            if (rest) n = rest;
        }
        return Object.assign({}, c, { name: lead + n + (i === 0 ? " · 마지막" : ` · 남은 ${i}화`) });
    });
}

// 오류를 쉬운 말로 (Aniyomi 확장과 같은 문구). Cloudflare 확인은 그대로 둠
function friendlyHttp(code) {
    if (code === 403) return "사이트가 접속을 막았어요 (HTTP 403). 오른쪽 위 웹뷰로 한 번 열어 본 뒤 다시 시도해 주세요.";
    if (code === 429) return "요청이 너무 많아 사이트가 잠시 막았어요 (HTTP 429). 1~2분 뒤 다시 시도해 주세요.";
    if (code >= 500 && code <= 599) return `사이트가 지금 응답하지 않아요 (HTTP ${code}). 잠시 뒤 다시 시도해 주세요.`;
    return null;
}

function friendlyError(e) {
    const m = String((e && e.message) || e || "");
    if (/cloudflare/i.test(m)) return m;
    if (/host lookup|UnknownHost|No address associated|nodename nor servname/i.test(m)) {
        return "사이트 주소에 접속할 수 없어요. 주소가 바뀌었을 수 있어요 — 설정에서 '도메인 자동 찾기'를 켜 두거나 새 주소를 넣어 주세요.";
    }
    if (/timed? ?out|timeout/i.test(m)) return "사이트 응답이 너무 늦어요 (시간 초과). 잠시 뒤 다시 시도해 주세요.";
    if (/Connection (refused|reset|closed|failed)|HandshakeException|SocketException|CERTIFICATE/i.test(m)) {
        return "사이트에 연결하지 못했어요. 인터넷 연결을 확인하거나 잠시 뒤 다시 시도해 주세요.";
    }
    return m;
}

// 주소 바뀜 대응 설정: 사이트 주소 모양, 진짜 사이트 표시 글자, User-Agent, 직접 넣은 주소 설정 키
const ADDR_HOST = AUTO_HOST;
const ADDR_MARK = MARK;
const ADDR_UA = MOBILE_UA;
const ADDR_PREF = "domain";

// ---------- 주소가 바뀐 것 같을 때 · 붙여 넣은 새 주소 (애니·웹툰 망가요미 파일 같은 코드, 위 ADDR_* 만 다름) ----------
const ADDR_HELP = "주소가 바뀐 것 같아요. 웹뷰로 열어 새 주소를 확인한 뒤 그 주소를 검색창에 붙여 넣어 주세요.";

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

// ---------- 회차 묶음·주소 확인 줄 (웹툰 망가요미 공통, 2026-11-16 굿툰에서 옮김) ----------
function hyphenChain(names) {
    const re = /(\d{1,5})\s*-\s*(\d{1,5})\s*화/;
    const items = [];
    for (const n of names || []) {
        const s = String(n || "").trim();
        const m = re.exec(s);
        if (m && +m[2] > +m[1]) items.push({ s, a: +m[1], b: +m[2] });
    }
    const starts = new Set(items.map((x) => x.a));
    const ends = new Set(items.map((x) => x.b));
    // 2026-11-14: 하나만 있는 "25-27화"·"11-12화" 도 묶음 — 같은 앞 번호의 다른 하이픈 회차("11-1화"·"11-2화" = 나눠 올린 회차, 덴마 "2-N화")가 없을 때만 (머니툰 손맛 시즌1)
    const sameA = {};
    for (const n of names || []) {
        const m = /(\d{1,5})\s*-\s*(\d{1,5})\s*화/.exec(String(n || ""));
        if (m) sameA[m[1]] = (sameA[m[1]] || 0) + 1;
    }
    return new Set(items.filter((x) => starts.has(x.b + 1) || ends.has(x.a - 1) || sameA[String(x.a)] === 1).map((x) => x.s));
}

function hyphenBundle(name, chain) {
    const s = String(name || "").trim();
    // "81화~85화" (앞 번호에도 "화") 도 "81~85화" 묶음으로 (머니툰 손맛)
    const u = s.replace(/(\d{1,5})\s*화\s*[~～]\s*(\d{1,5})(\s*화)/g, (x, a, b, h) => (+b > +a ? a + "~" + b + h : x));
    return chain && chain.has(s) ? u.replace(/(\d{1,5})\s*-\s*(\d{1,5})(\s*화)/, "$1~$2$3") : u;
}

function addrNoteSave(msg) {
    try {
        const d = new Date(Date.now() + 9 * 3600000);
        const z = (n) => String(n).padStart(2, "0");
        new SharedPreferences().setString("listed_note", `${z(d.getUTCMonth() + 1)}.${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())} ${msg}`);
    } catch (e) {
        // 그대로
    }
}

function addrNoteText() {
    try {
        const v = String(new SharedPreferences().getString("listed_note", "") || "");
        return v ? ` · 🔎 ${v}` : "";
    } catch (e) {
        return "";
    }
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    // ---------- 도메인: 수동 주소 > 자동으로 찾은 주소 > 기본 주소 ----------
    cleanUrl(v) {
        v = String(v || "").trim().replace(/\/+$/, "");
        return /^https?:\/\/[^\s/]+$/.test(v) ? v : "";
    }

    get base() {
        try {
            const prefs = new SharedPreferences();
            const manual = this.cleanUrl(prefs.get("domain"));
            // 직접 넣은 주소는 기본 주소와 같아도 그대로 씀 (설정 기본값은 빈 칸)
            if (manual) {
                // 직접 넣은 주소는 바로 씀. 단 자동 찾기로 그보다 번호가 큰 진짜 사이트 주소가 확인되면 그 주소로 바꾸고 설정 칸도 고침
                const newer = this.cleanUrl(prefs.getString("auto_domain", ""));
                const num = (u) => { const x = /(\d+)(?!.*\d)/.exec(String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\.[a-z]{2,6}$/i, "")); return x ? parseInt(x[1], 10) : 0; };
                if (newer && newer !== manual && num(newer) > num(manual) && this.autoOn()) {
                    prefs.setString("domain", newer);
                    return newer;
                }
                return manual;
            }
            // 자동으로 찾은 주소가 확장 업데이트로 바뀐 기본 주소보다 옛 번호면 기본 주소를 씀
            const auto = this.cleanUrl(prefs.getString("auto_domain", ""));
            const n = (u) => { const x = /(\d+)(?!.*\d)/.exec(String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\.[a-z]{2,6}$/i, "")); return x ? parseInt(x[1], 10) : 0; };
            return auto && n(auto) >= n(this.source.baseUrl) ? auto : this.source.baseUrl;
        } catch (e) {
            return this.source.baseUrl;
        }
    }

    autoOn() {
        try {
            const v = new SharedPreferences().get("auto_on");
            return v !== false && v !== "false";
        } catch (e) {
            return true;
        }
    }

    // 요청 + 오류를 쉬운 말로 (연결 오류, HTTP 403·429·5xx)
    async req(...args) {
        let res;
        try {
            res = await this.reqRaw(...args);
        } catch (e) {
            throw new Error(friendlyError(e));
        }
        const msg = friendlyHttp(res && Number(res.statusCode));
        if (msg) throw new Error(msg);
        return res;
    }

    /** 요청 실패(접속 불가 / 5xx / API 대신 다른 화면) 시 새 주소를 찾아 저장하고 같은 요청을 다시 보냄 */
    async reqRaw(url, headers) {
        await siteWait(url);
        const base = this.base;
        const ours = this.autoOn() && url.startsWith(base) && AUTO_HOST.test(base.replace(/^https?:\/\//, ""));
        const api = url.substring(base.length).startsWith("/api/");
        let failed = null;
        let error = null;
        let notice = null;
        try {
            const res = await this.client.get(url, headers || {});
            // 자동으로 찾은 주소가 막히면(403) 자동 주소를 지우고 기본 주소로 다시 요청
            if (ours && res.statusCode === 403 && base !== this.source.baseUrl && !this.cleanUrl(new SharedPreferences().get("domain"))) {
                new SharedPreferences().setString("auto_domain", "");
                const fb = this.source.baseUrl;
                const h = {};
                for (const k in headers || {}) h[k] = String(headers[k]).split(base).join(fb);
                const r2 = await this.client.get(fb + url.substring(base.length), h);
                if (r2.statusCode < 400) return r2;
            }
            if (ours && res.statusCode === 200 && !api) notice = await noticeTarget(this, res.body, base, MARK);
            // 정상 화면에 적힌 더 새 주소(사이트가 새 주소로 넘겨 준 경우 포함)를 자동 주소로 기억
            if (ours && !notice && res.statusCode === 200 && !api) {
                const self = await selfTarget(this, res.body, base, MARK);
                if (self) new SharedPreferences().setString("auto_domain", self);
            }
            // 옛 주소가 사이트 대신 다른 화면(주차 페이지 등)을 주면 API 가 JSON 이 아님
            const notApi = ours && api && res.statusCode === 200 && !/^\s*[{[]/.test(String(res.body || ""));
            if (!notice && !notApi && (!ours || !(res.statusCode >= 500))) return res;
            failed = res;
        } catch (e) {
            if (!ours) throw e;
            error = e;
        }
        const found = notice || await this.discover(base);
        if (notice) new SharedPreferences().setString("auto_domain", notice);
        if (!found) {
            if (error) throw error;
            return failed;
        }
        const h = {};
        for (const k in headers || {}) h[k] = String(headers[k]).split(base).join(found);
        return await this.client.get(found + url.substring(base.length), h);
    }

    async discover(current) {
        const prefs = new SharedPreferences();
        const last = Number(prefs.getString("auto_tried_at", "0")) || 0;
        if (Date.now() - last < 60 * 1000) return null;
        prefs.setString("auto_tried_at", String(Date.now()));

        const num = (u) => parseInt((String(u).match(AUTO_NUM) || [0, "0"])[1], 10) || 0;
        const cur = num(current) || num(this.source.baseUrl);
        const tld = (/\.([a-z]{2,6})$/.exec(String(current).replace(/\/+$/, "")) || [0, "com"])[1];
        const cands = [];
        for (let i = Math.max(1, cur - 3); i <= cur + 30; i++) {
            const c = `https://marumaru${i}.${tld}`;
            if (c !== current) cands.push(c);
        }
        const hits = await Promise.all(cands.map(async (c) => {
            try {
                const r = await this.client.get(c + "/", { "User-Agent": MOBILE_UA });
                return r.statusCode === 200 && String(r.body || "").includes(MARK) ? c : null;
            } catch (e) {
                return null;
            }
        }));
        const ok = hits.filter((x) => x);
        ok.sort((a, b) => num(b) - num(a));
        const found = ok[0] || null;
        if (found) prefs.setString("auto_domain", found);
        return found;
    }

    getHeaders(url) {
        return { "User-Agent": MOBILE_UA, "Referer": this.source.baseUrl + "/" };
    }

    hdr() {
        return { "User-Agent": MOBILE_UA, "Referer": this.base + "/" };
    }

    path(u) {
        return (u || "").replace(/^https?:\/\/[^/]+/, "");
    }

    async json(url) {
        const res = await this.req(url, this.hdr());
        const body = fixUtf8(res.body);
        if (!/^\s*[{[]/.test(body)) throw new Error(`사이트 응답을 읽을 수 없습니다 (상태 ${res.statusCode})`);
        return JSON.parse(body);
    }

    item(w) {
        return { name: w.title || "", imageUrl: w.thumbUrl || w.coverUrl || "", link: `/${SECTION}/${w.id}` };
    }

    works(d, page) {
        const items = d.items || [];
        const size = Number(d.size) || items.length || 1;
        const list = items.map((w) => this.item(w)).filter((x) => x.name);
        return { list, hasNextPage: list.length > 0 && page * size < (Number(d.total) || 0) };
    }

    // ---------- 목록 ----------
    /** /api/works?mediaType=…&page=(0부터)&size=… + 분류·정렬·요일·플랫폼·장르·초성 */
    worksUrl(q, page) {
        const p = [`mediaType=${MEDIA}`];
        if (q.category === "ADULT") p.push("adult=true");
        else if (q.category === "BLGL") p.push("blgl=true");
        // 사이트처럼 웹툰 기본 목록은 BL/GL 을 뺌 (완결 목록은 전체)
        else if (q.category !== "ALL" && MEDIA === "WEBTOON" && !q.completed) p.push("blgl=false");
        if (q.completed) p.push("completed=true");
        for (const k of ["weekday", "initial", "platform", "genre", "sort"]) if (q[k]) p.push(`${k}=${encodeURIComponent(q[k])}`);
        p.push(`page=${page - 1}`, `size=${PAGE_SIZE}`);
        return `${this.base}/api/works?` + p.join("&");
    }

    async basePopular(page) {
        return this.works(await this.json(this.worksUrl({ sort: "VIEW" }, page)), page);
    }

    async baseLatest(page) {
        return this.works(await this.json(this.worksUrl({ sort: "LATEST" }, page)), page);
    }

    async baseSearch(query, page, filters) {
        const q = {};
        let status = "";
        for (const f of filters || []) {
            if (f.type_name !== "SelectFilter" || !f.param || !f.values || !f.values[f.state]) continue;
            const v = f.values[f.state].value;
            if (f.param === "status") status = v; else q[f.param] = v;
        }
        const kw = String(query || "").trim();
        if (kw) {
            // 검색: 정렬은 최신·북마크·조회·화수만, 상태는 연재/완결
            const p = [`q=${encodeURIComponent(kw)}`, `page=${page - 1}`, `media=${MEDIA}`, `sort=${SEARCH_SORTS.indexOf(q.sort) >= 0 ? q.sort : "LATEST"}`];
            if (status === "completed") p.push("status=COMPLETED");
            else if (status === "ongoing") p.push("status=ON");
            return this.works(await this.json(`${this.base}/api/search?` + p.join("&")), page);
        }
        // 목록에는 "완결"만 있음 (연재중만 고르는 값은 사이트에 없음)
        q.completed = status === "completed";
        return this.works(await this.json(this.worksUrl(q, page)), page);
    }

    // ---------- 상세 + 회차 (100화씩 나뉜 회차 목록을 모두 받음) ----------
    /**
     * 회차 이름: 사이트 제목 그대로 ("59화 - 부제", "33-1화"). 단 앞에 (잘린) 작품 제목이 붙어 있으면 그 뒤 "N화"부터
     * ("여사친은 부탁하면 …외로 대준다 1화" → "1화"), 제목에 화 번호가 없으면 "N화 제목"
     */
    epName(num, title, work) {
        const t = String(title || "").trim();
        const w = String(work || "").trim();
        if (!(num >= 0)) return t || "회차";
        const n = String(num);
        const m = /(^|[^\d.-])(\d+(?:[-.]\d+)?\s*화)/.exec(t);
        if (m) {
            const head = t.substring(0, m.index + m[1].length).trim();
            const cut = head && (head.indexOf("…") >= 0 || (w && (w.startsWith(head) || head.startsWith(w))));
            return cut ? t.substring(m.index + m[1].length) : t;
        }
        if (!t || t === w) return `${n}화`;
        return `${n}화 ${t}`;
    }

    async getDetail(url) {
        const id = (/\/(?:webtoon|manhwa|novel)\/(\d+)/.exec(this.path(url)) || [])[1];
        if (!id) throw new Error("작품 주소를 알 수 없습니다");
        // 작품 정보와 회차 첫 쪽을 동시에, 나머지 쪽(100개씩)은 4개씩 동시에 받음 (2026-11-16: 차례로 받으면 896화 작품이 30초 넘게 걸림)
        const pageUrl = (p) => `${READER}/works/${id}?page=${p}&size=100&order=asc`;
        const [d, first] = await Promise.all([this.json(`${this.base}/api/works/${id}`), this.json(pageUrl(1))]);
        const w = d.work || {};
        const pages = [first];
        const last = Math.min(100, Math.ceil((Number(first.total) || 0) / 100));
        const failed = [];
        for (let p = 2; p <= last; p += 4) {
            const nums = [];
            for (let q = p; q < p + 4 && q <= last; q++) nums.push(q);
            const got = await Promise.all(nums.map((q) => this.json(pageUrl(q)).catch(() => null)));
            got.forEach((r, i) => (r ? pages.push(r) : failed.push(nums[i])));
        }
        // 회차 서버가 가끔 502·늦은 응답 → 실패한 쪽은 하나씩 두 번까지 다시
        const missed = [];
        for (const q of failed) {
            let r = null;
            for (let t = 0; t < 2 && !r; t++) r = await this.json(pageUrl(q)).catch(() => null);
            if (r) pages.push(r);
            else missed.push(q);
        }
        const chapters = [];
        const seen = {};
        for (const r of pages) {
            for (const e of r.episodes || []) {
                if (e.ready === false) continue;
                const u = `/${SECTION}/${id}/${e.id}`;
                if (seen[u]) continue;
                seen[u] = true;
                const num = Number(e.number);
                chapters.push({
                    name: this.epName(isNaN(num) ? -1 : num, e.title, w.title),
                    url: u,
                    num: isNaN(num) ? -1 : num,
                    dateUpload: e.published_at ? String(Date.parse(e.published_at)) : null
                });
            }
        }
        chapters.sort((a, b) => b.num - a.num);
        const info = [
            w.platform || "",
            WEEKDAY_NAMES[w.weekday] ? `${WEEKDAY_NAMES[w.weekday]}요일` : "",
            w.episodeCount ? `총 ${w.episodeCount}화` : ""
        ].filter((s) => s).join(" · ");
        return {
            name: w.title || "",
            imageUrl: w.coverUrl || w.thumbUrl || "",
            author: w.author || "",
            artist: d.illustrator || "",
            description: [missed.length ? `⚠️ 회차 일부(${missed.length}쪽, 약 ${missed.length * 100}화)를 사이트에서 못 받았어요 — 잠시 뒤 아래로 당겨 새로고침` : "", String(d.synopsis || "").trim(), info].filter((s) => s).join("\n\n"),
            genre: String(w.genres || "").split(",").map((s) => s.trim()).filter((s, i, a) => s && a.indexOf(s) === i),
            status: w.status === "SERIALIZING" ? 0 : w.status === "COMPLETED" ? 1 : w.status === "HIATUS" ? 2 : 5,
            link: `${this.base}/${SECTION}/${id}`,
            chapters: chapterPosition(chapters.map((c) => ({ name: c.name, url: c.url, dateUpload: c.dateUpload })), w.title || "")
        };
    }

    async episode(url) {
        const ep = this.path(url).replace(/[?#].*$/, "").split("/").filter((s) => s).pop();
        const d = await this.json(`${READER}/episodes/${ep}`);
        if (!d.item) throw new Error("회차 정보를 찾을 수 없습니다");
        // 사이트에서 포인트로 사야 하는 회차 (확장으로는 볼 수 없음)
        if ((d.item.body || []).some((b) => b && b.kind === "paid")) throw new Error(PAID_MSG);
        return d.item;
    }

    // ---------- 그림 (웹툰·만화) ----------
    async getPageList(url) {
        if (MEDIA === "NOVEL") return [];
        const it = await this.episode(url);
        const urls = [];
        for (const b of it.body || []) {
            if (b && (!b.kind || b.kind === "image") && /^https?:\/\//.test(b.url || "") && urls.indexOf(b.url) < 0) urls.push(b.url);
        }
        if (!urls.length) throw new Error("이미지를 찾을 수 없습니다 (준비 중인 회차일 수 있어요)");
        return urls.map((u) => ({ url: u, headers: { "Referer": this.base + "/", "User-Agent": MOBILE_UA } }));
    }

    // ---------- 본문 (소설) ----------
    async getHtmlContent(name, url) {
        const it = await this.episode(url);
        let raw = "";
        // 소설 본문은 embed_url 의 글자 파일 (웹툰처럼 회차 API 주소면 body 의 글 조각)
        if (/^https?:\/\//.test(it.embed_url || "") && it.embed_url.indexOf("/reader/") < 0) {
            const r = await this.req(it.embed_url, this.hdr());
            if (r.statusCode >= 400) throw new Error(`본문을 받지 못했습니다 (HTTP ${r.statusCode})`);
            raw = fixUtf8(r.body);
        } else {
            raw = (it.body || []).map((b) => (b && b.text) || "").join("\n");
        }
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const html = String(raw).replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l) => l).map((l) => `<p>${esc(l)}</p>`).join("");
        if (!html) throw new Error("본문이 비어 있습니다");
        const num = Number(it.number);
        return `<h2>${esc(this.epName(isNaN(num) ? -1 : num, it.title || name || ""))}</h2>` + html;
    }

    async cleanHtmlContent(html) {
        return html;
    }

    // ---------- 필터 ----------
    baseFilterList() {
        const sel = (name, param, pairs) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: pairs.map((p) => ({ type_name: "SelectOption", name: p[0], value: p[1] }))
        });
        const list = [{ type_name: "HeaderFilter", name: "검색어를 넣으면 제목 검색 (정렬 최신·북마크·조회·화수, 상태만 적용)" }];
        if (MEDIA === "WEBTOON") {
            list.push(sel("분류", "category", WEBTOON_CATEGORIES), sel("상태", "status", STATUSES), sel("정렬", "sort", SORTS),
                sel("요일", "weekday", WEEKDAYS), sel("플랫폼", "platform", opts(WEBTOON_PLATFORMS)), sel("장르", "genre", opts(WEBTOON_GENRES)));
        } else if (MEDIA === "MANHWA") {
            list.push(sel("분류", "category", CATEGORIES), sel("상태", "status", STATUSES), sel("정렬", "sort", SORTS),
                sel("플랫폼", "platform", opts(MANHWA_PLATFORMS)), sel("장르", "genre", opts(MANHWA_GENRES)));
        } else {
            list.push(sel("분류", "category", CATEGORIES), sel("상태", "status", STATUSES), sel("정렬", "sort", SORTS),
                sel("장르", "genre", opts(NOVEL_GENRES)));
        }
        list.push(sel("초성", "initial", opts(INITIALS)));
        return list;
    }

    tabLoad(key) {
        try {
            const v = JSON.parse(new SharedPreferences().getString(key, "") || "null");
            return Array.isArray(v) ? v : null;
        } catch (e) {
            return null;
        }
    }

    tabStore(key, value) {
        try {
            new SharedPreferences().setString(key, value === null ? "" : JSON.stringify(value));
        } catch (e) {
            // 저장 실패는 무시
        }
    }

    /** 저장된 상태값을 새 필터 목록에 채움 (필터 구성이 바뀐 항목은 기본값 유지) */
    tabRestore(states) {
        const list = this.tabFilterList();
        list.forEach((f, i) => {
            const s = states[i];
            if (s === null || s === undefined || !f || f.name === TAB_RULE_NAME) return;
            if (f.type_name === "SelectFilter" && typeof s === "number" && s >= 0 && s < f.values.length) f.state = s;
            else if (f.type_name === "TextFilter" && typeof s === "string") f.state = s;
            else if (f.type_name === "CheckBox" && typeof s === "boolean") f.state = s;
            else if (f.type_name === "GroupFilter" && Array.isArray(s)) f.state.forEach((c, k) => { c.state = !!s[k]; });
        });
        return list;
    }

    tabDescribe(key, base, fallback) {
        const states = this.tabLoad(key);
        if (!states) return fallback;
        const parts = [];
        base.forEach((f, i) => {
            const s = states[i];
            if (!f || f.name === TAB_RULE_NAME || s === null || s === undefined) return;
            if (f.type_name === "SelectFilter" && f.values[s]) {
                const label = String(f.name || "").replace(/\s*\(.*?\)\s*/g, "").trim();
                parts.push(label === "목록" || label === "정렬" ? f.values[s].name : `${label} ${f.values[s].name}`);
            }
            else if (f.type_name === "TextFilter" && String(s).trim()) parts.push(`${f.name}: ${s}`);
            else if (f.type_name === "CheckBox" && s === true) parts.push(f.name);
            else if (f.type_name === "GroupFilter" && Array.isArray(s)) {
                const on = f.state.filter((c, k) => s[k]).map((c) => c.name);
                if (on.length) parts.push(`장르 ${on.join(",")}`);
            }
        });
        return parts.join(" / ") || fallback;
    }

    async getPopular(page) {
        return addrGuard(this, page, () => this.popularGuarded(page));
    }

    async popularGuarded(page) {
        await statusRefresh(this.client);
        const s = this.tabLoad(TAB_KEY_POPULAR);
        return s ? this.baseSearch("", page, this.tabRestore(s)) : this.basePopular(page);
    }

    async getLatestUpdates(page) {
        return addrGuard(this, page, () => this.latestGuarded(page));
    }

    async latestGuarded(page) {
        await statusRefresh(this.client);
        const s = this.tabLoad(TAB_KEY_LATEST);
        return s ? this.baseSearch("", page, this.tabRestore(s)) : this.baseLatest(page);
    }

    async search(query, page, filters) {
        const byUrl = await openByUrl(this, query, (p) => { const m = /^\/(webtoon|manhwa|novel)\/(\d+)/.exec(p); return m && m[1] === SECTION ? `/${SECTION}/${m[2]}` : null; });
        if (byUrl) return byUrl;
        await statusRefresh(this.client);
        // 맨 위 상태 줄은 빼고 넘김 (규칙 저장 위치가 밀리지 않게)
        const list = withParams(filters, this.tabFilterList());
        const rule = list.find((f) => f && f.name === TAB_RULE_NAME);
        const r = rule ? Number(rule.state) || 0 : 0;
        if (r === 1 || r === 2) {
            const states = list.map((f) => {
                if (f && f.type_name === "GroupFilter" && Array.isArray(f.state)) return f.state.map((c) => !!c.state);
                return (!f || f.name === TAB_RULE_NAME || f.state === undefined || typeof f.state === "object") ? null : f.state;
            });
            this.tabStore(r === 1 ? TAB_KEY_POPULAR : TAB_KEY_LATEST, states);
        }
        if (r === 3 || r === 5) this.tabStore(TAB_KEY_POPULAR, null);
        if (r === 4 || r === 5) this.tabStore(TAB_KEY_LATEST, null);
        return this.baseSearch(query, page, list);
    }

    tabFilterList() {
        const base = this.baseFilterList();
        return base.concat([
            { type_name: "HeaderFilter", name: "조건을 고른 뒤 Filter를 누르면 저장됩니다." },
            { type_name: "HeaderFilter", name: `현재 Popular: ${this.tabDescribe(TAB_KEY_POPULAR, base, "기본값 (조회순)")}` },
            { type_name: "HeaderFilter", name: `현재 Latest: ${this.tabDescribe(TAB_KEY_LATEST, base, "기본값 (최신순)")}` },
            {
                type_name: "SelectFilter", name: TAB_RULE_NAME, state: 0,
                values: TAB_RULE_OPTIONS.map((n, i) => ({ type_name: "SelectOption", name: n, value: String(i) }))
            }
        ]);
    }

    // ---------- 상태 표시 ----------
    statusBase() {
        try {
            const b = typeof this.getBaseUrl === "function" ? this.getBaseUrl() : this.base;
            // getBaseUrl 이 비동기(Promise)인 확장은 마지막 정상 주소를 씀
            if (b && typeof b.then === "function") return (this.lastGood && this.lastGood()) || this.source.baseUrl;
            return b;
        } catch (e) {
            return this.source.baseUrl;
        }
    }

    statusAuto() {
        try {
            return typeof this.autoOn === "function" ? this.autoOn() : null;
        } catch (e) {
            return null;
        }
    }

    getFilterList() {
        return statusFilters(STATUS_KEY, this.statusBase(), this.statusAuto()).concat(this.tabFilterList());
    }

    getSourcePreferences() {
        return [{
            key: "chapter_position",
            switchPreferenceCompat: {
                title: "회차 이름에 남은 화 표시",
                summary: "예: 51화 · 남은 102화 (사이트 순번·작품 제목은 빼고 짧게). 끄면 원래 이름만 표시 (새 화가 올라오면 이름이 바뀌어, 다운로드한 회차가 안 받은 것처럼 보일 수 있음)",
                value: true
            }
        }, {
            key: "domain",
            editTextPreference: {
                title: "도메인 주소 (수동)",
                summary: "비워두면 자동으로 찾은 주소 사용. 직접 넣으면 그 주소를 우선 사용 (예: https://marumaru106.com)",
                value: "",
                dialogTitle: "도메인 주소",
                dialogMessage: "비워두면 자동"
            }
        }, {
            key: "auto_on",
            switchPreferenceCompat: {
                title: "도메인 자동 찾기",
                summary: "접속이 안 되면 marumaru###.com 중 열리는 주소로 자동 변경",
                value: true
            }
        }];
    }
}

/** 응답에 charset 이 없으면 망가요미가 Latin-1 로 넘기므로, UTF-8 바이트로 보고 다시 풀어 줌 (이미 한글이면 그대로) */
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

// ---------- 앱 기본 User-Agent 사용 ----------
// 망가요미는 내장 웹뷰에서 Cloudflare 확인을 통과하면 쿠키와 그 웹뷰의 User-Agent 를 함께 저장하고,
// 요청에 User-Agent 가 없을 때만 그 값을 넣는다. 확장이 고정 User-Agent 를 보내면 통과 쿠키가 거부되므로
// 사이트(문서·API) 요청에서는 확장의 User-Agent 를 빼고 앱 값을 쓰게 한다. 영상·이미지 주소 요청은 그대로 둔다.
// ---------- 망가요미가 돌려준 필터에 우리 표식(param/_status)이 빠져 있어도 동작하게 ----------
// 앱은 필터를 이름·상태값만 남겨 돌려줄 수 있어서, 같은 이름의 원래 필터에서 param 을 다시 채우고 상태 줄은 뺀다.
const STATUS_LINE = /^(?:📡|🩺|❌|🛡|📝)/;
function withParams(list, base) {
    const out = [];
    for (const f of list || []) {
        if (!f || f._status || (f.type_name === "HeaderFilter" && STATUS_LINE.test(String(f.name || "")))) continue;
        if (!f.param) {
            const b = (base || []).find((x) => x && x.name === f.name && x.type_name === f.type_name);
            if (b && b.param) f.param = b.param;
        }
        out.push(f);
    }
    return out;
}

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

// ---------- 필터 화면 맨 위 상태 표시 (주소 · 자동 찾기 · 감시 점검 결과) ----------
// 점검 결과는 저장소 감시 작업이 올리는 status.json 을 20분에 한 번 받아 두었다가 보여 준다.
const STATUS_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/monitor-state/status.json";

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
    const lines = [`📡 주소: ${host}` + (autoOn === null || autoOn === undefined ? "" : ` · 자동 찾기 ${autoOn ? "켜짐" : "꺼짐"}`) + addrNoteText()];
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
const NOTES_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/main/changelog.json";

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
// 시험판: 시험 저장소 목록에서 최신 버전 확인
const VER_INDEX_URLS = ["https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/index.json", "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/novel_index.json"];

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

const TWIN_NOTE = "";

function notesFilters(key) {
    let list = [];
    try {
        list = (JSON.parse(new SharedPreferences().getString("notes_json", "") || "{}").items || {})[key] || [];
    } catch (e) {
        list = [];
    }
    const out = [verLine(key, list.filter((n) => n && n.t)[0])];
    // 같은 작품·회차를 가진 확장 안내 (전체 웹툰 비교, 2026-11-06) — 확장 이름은 바꾸지 않음(서재 연결)
    if (TWIN_NOTE) out.push({ type_name: "HeaderFilter", name: "📝 🔗 " + TWIN_NOTE, _status: true });
    return out;
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

// ---------- 빠진 회차 번호 (2026-11-04) ----------
// 망가요미는 "N화 누락됨" 개수만 보여 줌 → 작품 설명 맨 위에 빠진 회차 번호를 적음 (회차 이름 맨 앞 번호 기준)
function missingNote(chapters) {
    const hyChain = hyphenChain((chapters || []).map((c) => c && c.name));
    const nums = {};
    let max = 0;
    let min = Infinity;
    for (const c of chapters || []) {
        // 여러 화를 묶은 회차("14~18화")는 그 범위를 모두 있는 것으로 (2026-11-11, 나 혼자 소설 속 망나니)
        const m = /^\D{0,6}?(\d{1,5})(?:\.\d+)?(?:\s*[~～]\s*(\d{1,5}))?\s*(?:화|회|부|권|장|편|$|\s|\D)/.exec(hyphenBundle(c && c.name, hyChain).trim().replace(/(\d{1,5})\s*,\s*(\d{1,5})(\s*화)/g, (x, a, b, h) => (+b > +a && +b - +a <= 3 ? a + "~" + b + h : x)));
        if (!m) continue;
        const n = Number(m[1]);
        if (!(n > 0) || n > 20000) continue;
        nums[n] = true;
        const end = Number(m[2] || 0);
        if (end > n && end - n <= 50) for (let k = n + 1; k <= end; k++) nums[k] = true;
        if (n > max) max = n;
        if (n < min) min = n;
    }
    if (!max || max - min > 5000) return "";
    // 가장 작은 번호 ~ 가장 큰 번호 사이만 (앞쪽 1~21화가 원래 없는 작품은 세지 않음, 애니요미와 같음)
    const miss = [];
    for (let i = min; i <= max; i++) if (!nums[i]) miss.push(i);
    if (!miss.length || miss.length > (max - min + 1) / 2) return "";
    const shown = miss.slice(0, 10).map((n) => `${n}화`).join(", ");
    return `⚠️ 빠진 회차: ${shown}${miss.length > 10 ? ` 외 ${miss.length - 10}개` : ""} (사이트에 없거나 확장이 못 받아 온 회차)`;
}
(function () {
    const base = DefaultExtension.prototype.getDetail;
    if (!base) return;
    DefaultExtension.prototype.getDetail = async function () {
        const d = await base.apply(this, arguments);
        try {
            const note = d ? missingNote(d.chapters) : "";
            if (note) d.description = note + (d.description ? "\n\n" + d.description : "");
        } catch (e) {
            // 그대로
        }
        return d;
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
        // 2026-11-11: 정렬이 붙인 차례 번호("86 · 시즌2 43화")가 있으면 그 번호 먼저 (가비지타임: 43 을 읽어 "43.43. 86 · …" 로 꼬였음)
        const pos = /^\s*(\d+(?:\.\d+)?) · /.exec(core);
        if (pos) return parseFloat(pos[1]);
        const m = /(\d+(?:[.-]\d+)?)\s*(?:화|회|話)/.exec(core);
        if (m) return parseFloat(m[1].replace("-", "."));
        return read(title, core).ep;
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const list = d && (d.episodes || d.chapters);
        if (!list || !list.length) return d;
        const title = String(d.name || "");
        // 2026-11-14: 여러 화를 묶은 회차("1~5화")가 있으면 앱이 묶음마다 "4화 누락"으로 셈(11toon 나의 히어로 아카데미아 "36화 누락됨")
        // → 그 작품만 오래된 회차부터 차례 번호 "N. " (진짜 빠진 회차는 설명 맨 위 ⚠️ 줄, 애니요미판과 같음)
        const hyChain = hyphenChain(list.map((x) => x.name));
        if (list.some((x) => { const m = /(\d{1,5})\s*[~～]\s*(\d{1,5})\s*화/.exec(hyphenBundle(x.name, hyChain).replace(/(\d{1,5})\s*,\s*(\d{1,5})(\s*화)/g, (x, a, b, h) => (+b > +a && +b - +a <= 3 ? a + "~" + b + h : x))); return m && +m[2] > +m[1]; })) {
            for (let i = list.length - 1, n = 1; i >= 0; i--, n++) {
                const plain = String(list[i].name || "").replace(/^\s*\d+(?:\.\d+)?\.\s+/, "").replace(/^\s*\d+(?:\.\d+)? · /, "");
                list[i].name = `${n}. ${plain}`;
            }
            return d;
        }
        // 앱이 기억한 제목이 조금 달라 지워지지 않는 경우까지 보려고 제목을 지운 것·안 지운 것 둘 다 확인
        if (ok(list, title) && ok(list, "")) return d;
        // 2026-11-11: 이름 속 "Episode3"·"EP 2" 는 앱이 맨 앞 번호보다 먼저 회차 번호로 읽음(북코 난공블락 로맨스 "122화 Episode3. 수확철" 26개가 3화로 겹침)
        // → 겹칠 때만 "Episode#3" 으로 바꿔 앱이 맨 앞 "122화" 를 읽게 함
        for (const x of list) x.name = String(x.name || "").replace(/\b(folge|episode|episodio|ep\.?)(\s*)(?=\d)/gi, "$1$2#");
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
