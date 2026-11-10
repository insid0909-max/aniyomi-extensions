const mangayomiSources = [{
    "name": "[시험] 오리365",
    "lang": "ko",
    "baseUrl": "https://v2.ohli365.org",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.0.2",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/ohli365.js"
}];

// 오리365(v2.ohli365.org, 2026-11-10, 해외에서도 열려 실제 구조 확인 후 만듦. 애니24(ohli24)와 이름만 비슷하고 다른 사이트)
// Next.js 화면: 주소에 머리글 "RSC: 1" 을 붙이면 화면 자료(글자)를 줌 → 그 안의 작품 자료(JSON)를 읽음
// 목록: /?tab={all|today|popular|new|ranking|recommend|completed|movie|quarter|weekday}[&sort=latest|popular|recommend][&filter=요일]&page=N,
//   카드 {"anime":{id,title,poster,status,releaseYear,episodeCount,…}}, 장르 /finder?tag=장르 (한 쪽에 전부, {"items":[…]}), 검색 /?q=
// 작품: /?title={id} (anime 자료 + "episodes":[{id,title,number,season}]), 회차 날짜는 사이트에 없음
// 재생: POST /api/home/playback {episodeId} → sources[].url (사이트 중계 주소의 HLS, 확장자가 .m3u8 이 아님)
const DEFAULT_BASE_URL = "https://v2.ohli365.org";
const DOMAIN_RE = /^https:\/\/(?:[a-z0-9-]+\.)?ohli\d*\.[a-z]{2,6}$|^https:\/\/(?:[a-z0-9-]+\.)?ohli365\d*\.[a-z]{2,6}$/;
const PASTE_RE = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)?ohli365\d*\.[a-z]{2,6})(?:[/?#]|$)/i;
const LABEL = "오리365";
const KEY = "ohli365";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함)
const KINDS = [
    ["전체", "all"], ["오늘 신작", "today"], ["인기 애니", "popular"], ["신규 랭킹", "new"], ["전체 랭킹", "ranking"],
    ["추천", "recommend"], ["완결", "completed"], ["극장판", "movie"], ["분기", "quarter"], ["요일", "weekday"],
];
const DAYS = ["월", "화", "수", "목", "금", "토", "일"];
const SORTS = [["기본", ""], ["최신순", "latest"], ["인기순", "popular"], ["추천순", "recommend"]];
const GENRES = ["전체", "코미디", "액션", "판타지", "드라마", "로맨스", "모험", "일상", "초자연", "SF", "미스터리", "에치",
    "심리", "스포츠", "음악", "메카", "스릴러", "공포", "마법소녀"];
// 장르 화면은 전체 작품을 주고 화면에서 거름 → 확장이 태그로 거름 (일부 작품은 태그가 영어)
const GENRE_EN = {
    "코미디": "Comedy", "액션": "Action", "판타지": "Fantasy", "드라마": "Drama", "로맨스": "Romance", "모험": "Adventure",
    "일상": "Slice of Life", "초자연": "Supernatural", "SF": "Sci-Fi", "미스터리": "Mystery", "에치": "Ecchi", "심리": "Psychological",
    "스포츠": "Sports", "음악": "Music", "메카": "Mecha", "스릴러": "Thriller", "공포": "Horror", "마법소녀": "Mahou Shoujo",
};
const FILTER_DEFS = [
    ["분류", "kind", KINDS.map((k) => k[0])],
    ["요일 (요일 분류만)", "day", DAYS],
    ["정렬", "sort", SORTS.map((s) => s[0])],
    ["장르 (고르면 분류·정렬 대신 장르 전체)", "genre", GENRES],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [2, 0, 0, 0];
const DEFAULT_LATEST = [0, 0, 1, 0];

let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 300 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

function ruleText(i) {
    if (i[3] > 0) return `장르 ${GENRES[i[3]]}`;
    return [
        KINDS[i[0]][0],
        KINDS[i[0]][1] === "weekday" ? DAYS[i[1]] : null,
        i[2] > 0 ? SORTS[i[2]][0] : null,
    ].filter((x) => x).join(" · ");
}

// 화면 자료는 글자 종류 표시(charset)가 없어 망가요미가 Latin-1 로 넘겨 줄 수 있음 → UTF-8 로 되돌림 (애니마루·북코와 같은 코드)
function fixUtf8(s) {
    s = String(s || "");
    if (/[^\u0000-ÿ]/.test(s) || !/[\u0080-ÿ]/.test(s)) return s;
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

// 글자 s 의 start 위치({ 또는 [)부터 짝이 맞는 곳까지 잘라 JSON 으로 읽음 (따옴표 안 괄호는 셈하지 않음)
function jsonAt(s, start) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (c === "\\") i++;
            else if (c === "\"") inStr = false;
            continue;
        }
        if (c === "\"") inStr = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(s.substring(start, i + 1));
                } catch (e) {
                    return null;
                }
            }
        }
    }
    return null;
}

const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

function first(el, css) {
    const l = el ? el.select(css) : [];
    return l && l.length ? l[0] : null;
}

function decodeHtml(s) {
    return String(s || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'");
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



class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    // ================= 주소 =================
    getBaseUrl() {
        let custom = "";
        try {
            custom = (new SharedPreferences().get(`${KEY}_domain`) || "").trim().replace(/\/+$/, "");
        } catch (e) {
            custom = "";
        }
        if (custom && !/^https?:\/\//.test(custom)) custom = "https://" + custom;
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    /** 화면 자료(RSC 글자) 받기 */
    async rsc(path) {
        const url = this.getBaseUrl() + path;
        const h = Object.assign(this.getHeaders(), { "RSC": "1" });
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, h);
            } catch (e) {
                if (attempt === 1) throw new Error(`${LABEL} 접속 실패: ${String((e && e.message) || e).substring(0, 80)}`);
                await new Promise((r) => setTimeout(r, 700));
            }
        }
        if (res.statusCode >= 400) {
            throw new Error(`${LABEL} 접속 실패 (HTTP ${res.statusCode}). 주소가 바뀌었으면 검색창에 새 주소를 붙여 넣거나 설정에 넣어 주세요.`);
        }
        return fixUtf8(res.body);
    }

    abs(u) {
        u = String(u || "");
        if (!u || /^https?:\/\//.test(u)) return u;
        return this.getBaseUrl() + (u.startsWith("/") ? u : "/" + u);
    }

    /** 작품 자료 → 목록 카드. 끝난 작품만 제목 뒤 (연도) */
    card(a) {
        let name = String(a.title || "").trim();
        if (a.status === "완결" && a.releaseYear && !name.includes(`(${a.releaseYear})`)) name = `${name} (${a.releaseYear})`;
        return { name, imageUrl: this.abs(a.poster), link: `/?title=${a.id}` };
    }

    /** 화면 자료 안의 작품 카드 {"anime":{…}} 와 장르 화면 {"items":[…]} 를 모두 읽음 */
    parseCards(s, page, tag) {
        const seen = {};
        const list = [];
        const add = (a) => {
            if (!a || !a.id || !a.title || seen[a.id]) return;
            if (tag && !(a.tags || []).some((t) => t === tag || t === GENRE_EN[tag])) return;
            seen[a.id] = true;
            list.push(this.card(a));
        };
        let i = -1;
        while ((i = s.indexOf("\"anime\":{", i + 1)) >= 0) add(jsonAt(s, i + 8));
        const it = s.indexOf("{\"items\":[");
        if (it >= 0) {
            const d = jsonAt(s, it);
            for (const a of (d && d.items) || []) add(a);
        }
        const next = new RegExp(`[?&]page=${page + 1}(?:&|"|$)`).test(s.replace(/\\u0026/g, "&"));
        return { list, hasNextPage: list.length > 0 && next };
    }

    // ================= 목록 =================
    listPath(idx, page) {
        if (idx[3] > 0) return `/finder?tag=${encodeURIComponent(GENRES[idx[3]])}`;
        const k = KINDS[idx[0]][1];
        const q = [`tab=${k}`];
        if (k === "weekday") q.push(`filter=${encodeURIComponent(DAYS[idx[1]])}`);
        if (idx[2] > 0) q.push(`sort=${SORTS[idx[2]][1]}`);
        if (page > 1) q.push(`page=${page}`);
        return "/?" + q.join("&");
    }

    async listPage(idx, page) {
        // 장르는 한 쪽에 전부
        if (idx[3] > 0 && page > 1) return { list: [], hasNextPage: false };
        return this.parseCards(await this.rsc(this.listPath(idx, page)), page, idx[3] > 0 ? GENRES[idx[3]] : "");
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return this.listPage(ruleRead(KEY, true, RULE_SIZES) || DEFAULT_POPULAR, page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead(KEY, false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품 주소를 붙여 넣으면 그 작품, 사이트 주소만 붙여 넣으면 그 주소를 설정에 넣고 인기 목록
        const idm = /[?&]title=([0-9a-f-]{36})/i.exec(query);
        const host = PASTE_RE.exec(query);
        if (host && page === 1) {
            const u = "https://" + host[1].toLowerCase();
            if (u !== this.getBaseUrl()) {
                try {
                    const r = await this.client.get(u + "/", this.getHeaders());
                    if (r.statusCode === 200 && /ohli365|OHLI365/i.test(String(r.body || ""))) new SharedPreferences().setString(`${KEY}_domain`, u);
                } catch (e) {
                    // 그대로 지금 주소 사용
                }
            }
            if (!idm) return this.getPopular(1);
        }
        if (idm) {
            const d = await this.getDetail(`/?title=${idm[1]}`);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: `/?title=${idm[1]}` }], hasNextPage: false };
        }
        if (query) {
            const q = [`q=${encodeURIComponent(query)}`];
            if (page > 1) q.push(`page=${page}`);
            return this.parseCards(await this.rsc("/?" + q.join("&")), page);
        }
        const idx = [0, 0, 0, 0];
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
    idOf(url) {
        const m = /title=([0-9a-f-]{36})/i.exec(String(url || ""));
        if (!m) throw new Error(`작품 주소가 이상해요: ${url}`);
        return m[1];
    }

    async getDetail(url) {
        const id = this.idOf(url);
        const s = await this.rsc(`/?title=${id}`);
        // 같은 작품 자료가 여러 번 나옴 → "details"(상세 정보)가 있는 것을 먼저
        let anime = null;
        let at = -1;
        let i = -1;
        const mark = `{"id":"${id}","title"`;
        while ((i = s.indexOf(mark, i + 1)) >= 0) {
            const a = jsonAt(s, i);
            if (a && (!anime || (a.details && !anime.details))) {
                anime = a;
                at = i;
            }
            if (anime && anime.details) break;
        }
        if (!anime) throw new Error(`작품 정보를 찾지 못했어요 [${s.length}자]`);
        const ei = s.indexOf("\"episodes\":[", at);
        const eps = (ei >= 0 ? jsonAt(s, ei + 11) : null) || [];
        const det = anime.details || {};
        const multiSeason = new Set(eps.map((e) => e.season || 1)).size > 1;
        // 사이트 순서와 상관없이 (시즌, 회차) 최신이 위
        const sorted = eps.filter((e) => e && e.id).slice().sort((a, b) => ((b.season || 1) - (a.season || 1)) || ((b.number || 0) - (a.number || 0)));
        const episodes = sorted.map((e) => {
            const no = Number(e.number) || 0;
            const t = String(e.title || "").trim();
            // 회차 이름은 회차 번호로 시작 (망가요미가 맨 앞 숫자를 회차로 읽음), 제목이 "N화" 가 아니면 뒤에
            const name = `${no}화` + (t && !/^\s*\d+\s*화\s*$/.test(t) ? ` ${t}` : "");
            const ep = { name, url: `/?title=${id}&ep=${e.id}`, dateUpload: null };
            if (multiSeason) ep.scanlator = `시즌${e.season || 1}`;
            return ep;
        });
        const ongoing = anime.status === "방영중";
        const done = anime.status === "완결" || !!det.endDate;
        let name = String(anime.title || "").trim();
        if (!ongoing && anime.releaseYear && !name.includes(`(${anime.releaseYear})`)) name = `${name} (${anime.releaseYear})`;
        const info = [
            ongoing ? "방영 중" : "",
            det.startDate ? `방영 시작: ${det.startDate}` : "",
            det.endDate ? `방영 끝: ${det.endDate}` : "",
            anime.episodeCount ? `총 회차: ${anime.episodeCount}` : "",
            (det.studios || []).length ? `제작: ${det.studios.join(", ")}` : "",
            (anime.searchTitles || []).length ? `원제: ${anime.searchTitles[0]}` : "",
            eps.length && eps.every((e) => e.koreanSubtitleStatus !== "verified") ? "한국어 자막: 사이트가 확인 안 함 (자막 없이 나올 수 있음)" : "",
        ].filter((x) => x).join("\n");
        return {
            name,
            imageUrl: this.abs(anime.poster),
            link: `${this.getBaseUrl()}/?title=${id}`,
            description: [info, String(anime.synopsis || "").replace(/\n{3,}/g, "\n\n").trim()].filter((x) => x).join("\n\n"),
            author: (det.studios || []).join(", "),
            status: ongoing ? 0 : done ? 1 : 5,
            genre: anime.tags || [],
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        const id = this.idOf(url);
        const ep = (/[?&]ep=([0-9a-f-]{36})/i.exec(String(url)) || [])[1];
        if (!ep) throw new Error("회차 주소가 이상해요. 회차 목록을 아래로 당겨 새로고침해 주세요");
        const base = this.getBaseUrl();
        const h = {
            "User-Agent": UA,
            "Referer": `${base}/?title=${id}`,
            "Origin": base,
            "Content-Type": "application/json",
            "Accept": "application/json",
        };
        // 본문은 객체로 (망가요미가 JSON 으로 바꿔 보냄. 글자로 주면 한 번 더 감싸 사이트가 "재생 대상을 확인해 주세요" 400 — 0.0.1 휴대폰)
        const res = await this.client.post(`${base}/api/home/playback`, h, { episodeId: ep });
        let d = null;
        try {
            d = JSON.parse(fixUtf8(res.body));
        } catch (e) {
            d = null;
        }
        if (!d || res.statusCode >= 400) throw new Error(`재생 정보를 받지 못했어요 (HTTP ${res.statusCode}) ${String((d && (d.error || d.message)) || "").substring(0, 80)}`);
        const subtitles = (d.subtitles || []).map((t) => ({
            file: this.abs(t.url || t.file || t.src || ""),
            label: String(t.label || t.language || t.lang || "자막"),
        })).filter((t) => /^https?:\/\//.test(t.file));
        const sources = (d.sources || []).filter((x) => x && x.url);
        if (!sources.length && d.sourceUrl) sources.push({ url: d.sourceUrl, label: "" });
        if (!sources.length) throw new Error("재생 주소가 없어요 (사이트에 아직 영상이 없을 수 있어요)");
        const vh = { "User-Agent": UA, "Referer": `${base}/`, "Origin": base };
        const out = [];
        for (let n = 0; n < sources.length; n++) {
            const label = n === 0 ? LABEL : `${LABEL} (대체 ${n})`;
            for (const v of await this.expand(this.abs(sources[n].url), label, vh)) {
                v.subtitles = subtitles;
                out.push(v);
            }
        }
        return qualitySort(`${KEY}_quality`, out);
    }

    /** 재생 목록을 받아 화질이 여러 개면 나눔. 주소가 .m3u8 로 끝나지 않아 originalUrl 끝에 "#download.m3u8" (망가요미 재생기가 HLS 로 알아보게) */
    async expand(url, label, headers) {
        const hint = (u) => String(u).replace(/#.*$/, "") + "#download.m3u8";
        const one = [{ url, originalUrl: hint(url), quality: `${label} 자동`, headers }];
        let body = "";
        try {
            const r = await this.client.get(url, headers);
            if (Number(r.statusCode) >= 400) return one;
            body = String(r.body || "").replace(/\r/g, "");
        } catch (e) {
            return one;
        }
        if (!body.trim().startsWith("#EXTM3U")) return one;
        const variants = [];
        const seen = {};
        const re = /#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)/g;
        let m;
        while ((m = re.exec(body))) {
            const hm = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
            const hgt = hm ? Number(hm[1]) : 0;
            let u = m[2].trim();
            if (!/^https?:\/\//.test(u)) u = u.startsWith("/") ? (/^(https?:\/\/[^/]+)/.exec(url) || [null, ""])[1] + u : url.replace(/[^/]*(?:\?.*)?$/, "") + u;
            if (seen[u]) continue;
            seen[u] = true;
            variants.push({ h: hgt, u });
        }
        if (!variants.length) return one;
        variants.sort((a, b) => b.h - a.h);
        if (variants.length === 1) return [{ url, originalUrl: hint(url), quality: `${label} ${variants[0].h ? variants[0].h + "p" : "원본"}`, headers }];
        return [{ url, originalUrl: hint(url), quality: `${label} 자동 (최대 ${variants[0].h}p)`, headers }]
            .concat(variants.map((v) => ({ url: v.u, originalUrl: hint(v.u), quality: `${label} ${v.h ? v.h + "p" : "원본"}`, headers })));
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${host}` },
            ...notesFilters(KEY),
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품·사이트 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), ruleFilters(KEY, RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: `${KEY}_domain`,
            editTextPreference: {
                title: "오리365 주소 직접 지정 (선택)",
                summary: `비워 두면 기본 주소(${DEFAULT_BASE_URL})를 사용합니다. 검색창에 새 주소를 붙여 넣어도 됩니다.`,
                value: "",
                dialogTitle: "오리365 주소",
                dialogMessage: "https:// 로 시작하는 오리365 주소 (예: https://v2.ohli365.org)",
            },
        }, qualityPreference(`${KEY}_quality`)];
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
const VER_INDEX_URLS = ["https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/index.json"];

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
