const mangayomiSources = [{
    "name": "실시간스포츠2",
    "lang": "ko",
    "baseUrl": "https://www.tongtv.net",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "version": "0.1.1",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/livesports2.js"
}];

// Aniyomi LiveSports2.kt(통티비)를 망가요미용으로 옮긴 소스.
// 망가요미에는 숨은 브라우저가 없어서, 플레이어 페이지 글자 안에서 영상 주소를 찾고
// 헤더를 붙여 바로 재생한다 (Aniyomi의 "직접" 재생과 같은 방식).
const DEFAULT_BASE_URL = "https://www.tongtv.net";
const DOMAIN_RE = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Mobile Safari/537.36";
const THUMB_BASE = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs";
const M3U8_RE = /https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/gi;

const SRC_LIVE = "live";
const SRC_SOON = "soon";
const ALL_CAT = "전체 경기";
const CAT_OTHER = "기타";
const CHOICE_ALL = "전체";
const CHOICE_EACH = "종목별 카드 모두";
const SORT_CATEGORY = "category";
const SORT_TIME = "time";

const CATEGORY_ORDER = [
    "축구", "야구", "농구", "배구", "하키", "테니스", "미식축구",
    "e스포츠", "격투기", "골프", "배드민턴", "탁구", "핸드볼", "럭비", "크리켓",
];
const CATEGORY_CHOICES = [CHOICE_ALL, CHOICE_EACH].concat(CATEGORY_ORDER, [CAT_OTHER]);

const SPORT_LABELS = {
    SOCCER: "축구", BASEBALL: "야구", BASKETBALL: "농구", VOLLEYBALL: "배구", VOLLEY: "배구",
    HOCKEY: "하키", ICEHOCKEY: "하키", TENNIS: "테니스", FOOTBALL: "미식축구",
    AMERICANFOOTBALL: "미식축구", NFL: "미식축구", EGAME: "e스포츠", LOL: "e스포츠", ESPORTS: "e스포츠",
    BOXING: "격투기", MMA: "격투기", UFC: "격투기", GOLF: "골프", BADMINTON: "배드민턴",
    TABLETENNIS: "탁구", HANDBALL: "핸드볼", RUGBY: "럭비", CRICKET: "크리켓",
};
const EMOJI = {
    "축구": "⚽", "야구": "⚾", "농구": "🏀", "배구": "🏐", "하키": "🏒", "테니스": "🎾", "미식축구": "🏈",
    "e스포츠": "🎮", "격투기": "🥊", "골프": "⛳", "배드민턴": "🏸", "탁구": "🏓", "핸드볼": "🤾",
    "럭비": "🏉", "크리켓": "🏏",
};
const THUMB_NAMES = {
    "축구": "soccer", "야구": "baseball", "농구": "basketball", "배구": "volleyball", "하키": "hockey",
    "테니스": "tennis", "미식축구": "americanfootball", "e스포츠": "esports", "격투기": "fight",
    "골프": "golf", "배드민턴": "badminton", "탁구": "tabletennis", "핸드볼": "handball",
    "럭비": "rugby", "크리켓": "cricket",
};

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    // ================= 설정 =================
    pref(key, def) {
        try {
            const v = new SharedPreferences().get(key);
            return v === null || v === undefined || v === "" ? def : v;
        } catch (e) {
            return def;
        }
    }

    getBaseUrl() {
        const custom = String(this.pref("ls2_domain", "")).trim().replace(/\/+$/, "");
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    siteHost() {
        return this.getBaseUrl().replace(/^https:\/\//, "").replace(/^www\./, "");
    }

    apiBase() {
        return `https://live.${this.siteHost()}`;
    }

    headers() {
        const base = this.getBaseUrl();
        return {
            "User-Agent": UA,
            "Referer": `${base}/`,
            "Origin": base,
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        };
    }

    // ================= 경기 목록 =================
    collectionOf(src) {
        return src === SRC_SOON ? "view_bw_live_soon" : "view_bw_live_on";
    }

    async fetchItems(src, filter, perPage) {
        const url = `${this.apiBase()}/api/collections/${this.collectionOf(src)}/records` +
            `?page=1&perPage=${perPage}&skipTotal=true&filter=${encodeURIComponent(filter)}`;
        const res = await this.client.get(url, this.headers());
        try {
            return JSON.parse(res.body).items || [];
        } catch (e) {
            return [];
        }
    }

    sportLabel(raw) {
        const k = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!k) return "";
        return SPORT_LABELS[k] || raw;
    }

    str(o, key) {
        const v = o[key];
        return v === null || v === undefined ? "" : String(v).trim();
    }

    async fetchGames(src) {
        const items = await this.fetchItems(src, "sports != \"ETC\"", 500);
        const stripN = this.pref("ls2_strip_n", true) !== false;
        const games = [];
        for (const o of items) {
            const id = this.str(o, "id");
            if (!id) continue;
            const fix = (s) => (stripN ? s.replace(/\s*\(N\)/g, "").trim() : s);
            const home = fix(this.str(o, "team_name_home"));
            const away = fix(this.str(o, "team_name_away"));
            const title = (home && away ? `${home} vs ${away}` : [home, away].filter((x) => x).join(" ")) ||
                `경기 ${id.substring(0, 4)}`;
            games.push({
                id: id, src: src, title: title, home: home, away: away,
                league: this.str(o, "league_name").replace(/\s+/g, " "),
                label: this.sportLabel(this.str(o, "sports")),
                qTime: this.str(o, "q_time"),
                scoreHome: this.str(o, "score_home"),
                scoreAway: this.str(o, "score_away"),
                startKey: this.str(o, "time_gmt9"),
                altIds: [],
            });
        }
        if (this.pref("ls2_merge", true) === false) return games;

        // 같은 경기(종목·팀·시작 시각이 같음)가 여러 줄로 올라오면 한 줄로 합친다
        const merged = {};
        const order = [];
        for (const g of games) {
            const key = !g.home && !g.away ? `id:${g.id}` : `${g.label}|${g.home}|${g.away}|${g.startKey}`;
            if (merged[key]) {
                merged[key].altIds.push(g.id);
            } else {
                merged[key] = g;
                order.push(key);
            }
        }
        return order.map((k) => merged[k]);
    }

    // ================= 카드 =================
    isAllCat(cat) {
        return cat === ALL_CAT || cat === CHOICE_ALL;
    }

    cardLink(p) {
        let link = `/tong?src=${p.src}&cat=${encodeURIComponent(p.cat)}&sort=${p.sort}`;
        if (p.q) link += `&q=${encodeURIComponent(p.q)}`;
        return link;
    }

    paramsFromLink(link) {
        const get = (name) => {
            const m = new RegExp(`[?&]${name}=([^&]*)`).exec(link || "");
            return m ? decodeURIComponent(m[1]) : "";
        };
        return {
            src: get("src") === SRC_SOON ? SRC_SOON : SRC_LIVE,
            cat: get("cat") || ALL_CAT,
            sort: get("sort") === SORT_TIME ? SORT_TIME : SORT_CATEGORY,
            q: get("q"),
        };
    }

    cardTitle(p) {
        const prefix = p.src === SRC_SOON ? "⏰ 예정 · " : "";
        let core;
        if (p.q) core = `🔎 "${p.q}"`;
        else if (this.isAllCat(p.cat)) core = "📡 전체 경기";
        else if (p.cat === CAT_OTHER) core = "🏅 기타 종목";
        else core = `${EMOJI[p.cat] || "🏅"} ${p.cat}`;
        return prefix + core;
    }

    thumbUrl(cat) {
        const name = this.isAllCat(cat) ? "all" : (THUMB_NAMES[cat] || "other");
        return `${THUMB_BASE}/${name}.png`;
    }

    makeCard(p) {
        return { name: this.cardTitle(p), imageUrl: this.thumbUrl(p.cat), link: this.cardLink(p) };
    }

    // 현재 목록에 있는 종목만 카드로 만든다
    cardsFor(games, src, sort) {
        const present = {};
        for (const g of games) present[g.label] = true;
        const cards = [this.makeCard({ src: src, cat: ALL_CAT, sort: sort, q: "" })];
        for (const c of CATEGORY_ORDER) {
            if (present[c]) cards.push(this.makeCard({ src: src, cat: c, sort: sort, q: "" }));
        }
        if (Object.keys(present).some((l) => l && !CATEGORY_ORDER.includes(l))) {
            cards.push(this.makeCard({ src: src, cat: CAT_OTHER, sort: sort, q: "" }));
        }
        return cards;
    }

    async getPopular(page) {
        return { list: this.cardsFor(await this.fetchGames(SRC_LIVE), SRC_LIVE, SORT_CATEGORY), hasNextPage: false };
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return { list: this.cardsFor(await this.fetchGames(SRC_SOON), SRC_SOON, SORT_CATEGORY), hasNextPage: false };
    }

    async search(query, page, filters) {
        const state = (i) => (filters && filters[i] && filters[i].state) || 0;
        const src = state(0) === 1 ? SRC_SOON : SRC_LIVE;
        const choice = CATEGORY_CHOICES[state(1)] || CHOICE_ALL;
        const sort = state(2) === 1 ? SORT_TIME : SORT_CATEGORY;
        const q = (query || "").trim();
        const cat = choice === CHOICE_EACH || choice === CHOICE_ALL ? ALL_CAT : choice;

        if (!q && choice === CHOICE_EACH) {
            return { list: this.cardsFor(await this.fetchGames(src), src, sort), hasNextPage: false };
        }
        return { list: [this.makeCard({ src: src, cat: cat, sort: sort, q: q })], hasNextPage: false };
    }

    // ================= 상세 (경기 목록) =================
    matches(g, p) {
        let catOk;
        if (this.isAllCat(p.cat)) catOk = true;
        else if (p.cat === CAT_OTHER) catOk = !CATEGORY_ORDER.includes(g.label);
        else catOk = g.label === p.cat;
        const q = (p.q || "").toLowerCase();
        const qOk = !q || [g.home, g.away, g.league, g.label].some((x) => x.toLowerCase().includes(q));
        return catOk && qOk;
    }

    categoryRank(label) {
        if (!label) return CATEGORY_ORDER.length + 1;
        const i = CATEGORY_ORDER.indexOf(label);
        return i >= 0 ? i : CATEGORY_ORDER.length;
    }

    startShort(key) {
        return key.length >= 16 ? key.substring(5, 16) : key;
    }

    async getDetail(url) {
        const p = this.paramsFromLink(url);
        const games = (await this.fetchGames(p.src)).filter((g) => this.matches(g, p));
        const live = p.src !== SRC_SOON;

        const episodes = [];
        if (games.length === 0) {
            episodes.push({ name: live ? "ℹ️ 현재 방송 중인 경기가 없습니다" : "ℹ️ 예정된 경기가 없습니다", url: "/play?kind=none" });
        } else {
            const ordered = games.slice().sort((a, b) => {
                if (p.sort === SORT_TIME) return (a.startKey || "9999").localeCompare(b.startKey || "9999");
                const ra = this.categoryRank(a.label);
                const rb = this.categoryRank(b.label);
                if (ra !== rb) return ra - rb;
                if (ra === CATEGORY_ORDER.length && a.label !== b.label) return a.label.localeCompare(b.label);
                return (a.startKey || "9999").localeCompare(b.startKey || "9999");
            });
            const counts = {};
            for (const g of ordered) counts[g.label] = (counts[g.label] || 0) + 1;
            const useEmoji = this.pref("ls2_emoji", true) !== false;
            const showScore = this.pref("ls2_score", true) !== false;
            const showHeaders = p.sort === SORT_CATEGORY && !p.q && (this.isAllCat(p.cat) || p.cat === CAT_OTHER);

            let last = null;
            for (const g of ordered) {
                const emoji = useEmoji ? (EMOJI[g.label] || (g.label ? "🏅" : "")) : "";
                if (showHeaders && g.label !== last) {
                    const head = [emoji, g.label || "기타", `(${counts[g.label]})`].filter((x) => x).join(" ");
                    episodes.push({ name: `━━ ${head} ━━`, url: `/play?kind=header&n=${episodes.length}` });
                }
                last = g.label;

                let info;
                if (!live) {
                    info = g.startKey ? `시작 ${this.startShort(g.startKey)}` : "";
                } else {
                    const score = showScore && g.scoreHome && g.scoreAway ? `${g.scoreHome}:${g.scoreAway}` : "";
                    info = [g.qTime, score].filter((x) => x).join(" · ");
                }
                let name;
                if (!g.label) name = g.title;
                else if (useEmoji) name = `${emoji} ${g.title}`;
                else name = `[${g.label}] ${g.title}`;
                episodes.push({
                    name: name,
                    url: `/play?id=${[g.id].concat(g.altIds).join(",")}&src=${g.src}`,
                    scanlator: [info, g.label, g.league].filter((x) => x).join(" · "),
                });
            }
        }

        return {
            name: this.cardTitle(p),
            imageUrl: this.thumbUrl(p.cat),
            description: `${live ? "방송 중" : "예정"} ${games.length}경기 · 정렬: ${p.sort === SORT_TIME ? "시간순" : "종목순"}`,
            status: 0,
            genre: [],
            link: url,
            episodes: episodes,
        };
    }

    // ================= 재생 =================
    async getVideoList(url) {
        if (url.includes("kind=header")) throw new Error("구분 줄입니다. 아래의 경기를 선택하세요");
        if (url.includes("kind=none")) throw new Error("선택할 수 있는 경기가 없습니다");

        const p = this.paramsFromLink(url);
        const idMatch = /[?&]id=([^&]*)/.exec(url);
        const ids = (idMatch ? decodeURIComponent(idMatch[1]) : "").split(",")
            .map((x) => x.trim()).filter((x) => /^[A-Za-z0-9]{6,40}$/.test(x)).slice(0, 4);
        if (ids.length === 0) throw new Error("선택할 수 있는 경기가 없습니다");

        // 재생할 때 그 경기의 항목을 다시 조회해서 최신 플레이어 정보(web)를 받는다
        const items = await this.fetchItems(p.src, ids.map((id) => `id = "${id}"`).join(" || "), 4);
        if (items.length === 0) throw new Error("경기 정보를 찾지 못했습니다. 방송이 끝났을 수 있으니 목록을 새로고침하세요");

        const errors = [];
        for (let i = 0; i < items.length; i++) {
            const web = this.str(items[i], "web");
            if (!web) {
                errors.push(`#${i + 1} 영상 없음`);
                continue;
            }
            try {
                return await this.resolveVideos(web, i === 0 ? "" : ` (대체 ${i + 1})`);
            } catch (e) {
                errors.push(`#${i + 1} ${e.message || e}`);
            }
        }
        throw new Error(errors.join(" || ") || "이 경기는 아직 영상이 준비되지 않았습니다");
    }

    // web 값은 iframe 태그(또는 주소)이므로 그 주소를 열어 글자 안에서 m3u8을 찾는다
    async resolveVideos(web, suffix) {
        const base = this.getBaseUrl();
        const site = this.siteHost();
        const filled = web.replace(/\{position\}/g, "1").replace(/\{width\}/g, "100%").replace(/\{height\}/g, "100%")
            .replace(/\{sourceDomain\}/g, site).replace(/\{poster\}/g, site);
        const srcMatch = /<iframe[^>]+src=["']([^"']+)["']/i.exec(filled);
        const playerUrl = this.resolveUrl(`${base}/broadcast`, srcMatch ? srcMatch[1] : filled.trim());

        // liventv 플레이어는 주소의 v 값을 AES로 풀어 m3u8을 얻는다 (앞 16자 = IV, 뒤 16자 = 키)
        let m3u8 = decryptPlayerParam(playerUrl) || this.findM3u8(filled);
        let referer = playerUrl;
        if (!m3u8 && /^https?:\/\//.test(playerUrl)) {
            const found = await this.searchPage(playerUrl, `${base}/broadcast`, 0);
            if (found) {
                m3u8 = found.url;
                referer = found.referer;
            }
        }
        if (!m3u8) throw new Error(`영상 주소를 찾지 못함 [${playerUrl.substring(0, 60)}]`);

        // 앱에서 접근 가능한 헤더 조합을 찾는다 (Aniyomi 확장과 같은 3가지)
        const playerOrigin = (/^(https?:\/\/[^/]+)/.exec(referer) || [null, ""])[1];
        const variants = [
            ["liventv", { "Referer": "https://liventv.com/", "Origin": "https://liventv.com" }],
            ["플레이어", { "Referer": referer, "Origin": playerOrigin }],
            ["tongtv", { "Referer": `${base}/`, "Origin": base }],
            ["UA만", {}],
        ];
        const log = [];
        for (const [label, extra] of variants) {
            const h = Object.assign({ "User-Agent": UA, "Accept": "*/*" }, extra);
            try {
                const res = await this.client.get(m3u8, h);
                if (res.statusCode === 200 && String(res.body).trim().startsWith("#EXTM3U")) {
                    return [{ url: m3u8, originalUrl: m3u8, quality: `직접 [${label}]${suffix}`, headers: h }];
                }
                log.push(`${label}:${res.statusCode}`);
            } catch (e) {
                log.push(`${label}:오류`);
            }
        }
        throw new Error(`재생 실패 [${m3u8.substring(0, 60)}] ${log.join(" | ")}`);
    }

    // 페이지 → 그 안의 iframe(2단계까지) → 압축된 스크립트 순서로 m3u8을 찾는다
    async searchPage(url, referer, depth) {
        let body;
        try {
            body = (await this.client.get(url, { "User-Agent": UA, "Referer": referer })).body;
        } catch (e) {
            return null;
        }
        const direct = this.findM3u8(body);
        if (direct) return { url: direct, referer: url };
        if (depth >= 2) return null;
        const frames = [];
        const re = /<iframe[^>]+src=["']([^"']+)["']/gi;
        let m;
        while ((m = re.exec(body)) !== null) frames.push(this.resolveUrl(url, m[1]));
        for (const f of frames) {
            if (!/^https?:\/\//.test(f)) continue;
            const found = await this.searchPage(f, url, depth + 1);
            if (found) return found;
        }
        return null;
    }

    findM3u8(text) {
        if (!text) return null;
        const pick = (s) => {
            const all = s.replace(/\\\//g, "/").match(M3U8_RE) || [];
            return all.find((u) => u.includes("playlist.m3u8")) || all[0] || null;
        };
        const direct = pick(text);
        if (direct) return direct;
        const packed = text.match(/eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\)\)\)?/g) || [];
        for (const code of packed) {
            try {
                const found = pick(unpackJs(code));
                if (found) return found;
            } catch (e) {
                // 다음 스크립트
            }
        }
        return null;
    }

    resolveUrl(base, target) {
        const t = (target || "").trim();
        if (!t) return "";
        if (/^https?:\/\//.test(t)) return t;
        if (t.startsWith("//")) return `https:${t}`;
        const origin = (/^(https?:\/\/[^/]+)/.exec(base) || [null, ""])[1];
        if (t.startsWith("/")) return origin + t;
        const path = base.replace(/[?#].*$/, "");
        return path.substring(0, path.lastIndexOf("/") + 1) + t;
    }

    // ================= 필터 / 설정 =================
    getFilterList() {
        const select = (name, labels) => ({
            type_name: "SelectFilter",
            name: name,
            state: 0,
            values: labels.map((l, i) => ({ type_name: "SelectOption", name: l, value: String(i) })),
        });
        // search()에서 0, 1, 2번 순서로 읽음. 검색창에 팀명이나 대회명을 넣으면 해당 경기만 보임
        return [
            select("범위", ["방송 중", "예정"]),
            select("종목", CATEGORY_CHOICES),
            select("정렬", ["종목순", "시간순"]),
        ];
    }

    getSourcePreferences() {
        return [
            {
                key: "ls2_domain",
                editTextPreference: {
                    title: "사이트 주소 직접 지정 (선택)",
                    summary: "비워 두면 기본 주소(https://www.tongtv.net)를 사용합니다.",
                    value: "",
                    dialogTitle: "사이트 주소",
                    dialogMessage: "https:// 로 시작하는 주소를 입력하세요.",
                },
            },
            {
                key: "ls2_emoji",
                switchPreferenceCompat: { title: "종목 이모지 표시", summary: "끄면 [축구] 형태로 표시합니다.", value: true },
            },
            {
                key: "ls2_score",
                switchPreferenceCompat: { title: "점수·진행 상황 표시", summary: "방송 중인 경기 줄에 표시합니다.", value: true },
            },
            {
                key: "ls2_merge",
                switchPreferenceCompat: {
                    title: "같은 경기 합치기",
                    summary: "같은 경기가 여러 줄로 올라오면 한 줄로 합치고, 재생할 때 되는 중계를 자동으로 고릅니다.",
                    value: true,
                },
            },
            {
                key: "ls2_strip_n",
                switchPreferenceCompat: { title: "팀 이름의 (N) 표기 지우기", summary: "", value: true },
            },
        ];
    }
}

// ================= AES-128-CBC 복호화 (liventv 플레이어 v 값) =================
const AES_SBOX = (() => {
    const sbox = new Array(256);
    const inv = new Array(256);
    let p = 1;
    let q = 1;
    do {
        p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
        q ^= q << 1;
        q ^= q << 2;
        q ^= q << 4;
        q &= 0xff;
        if (q & 0x80) q ^= 0x09;
        const x = (q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4)) ^ 0x63) & 0xff;
        sbox[p] = x;
    } while (p !== 1);
    sbox[0] = 0x63;
    for (let i = 0; i < 256; i++) inv[sbox[i]] = i;
    return { sbox, inv };
})();

function aesXtime(a) {
    return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function aesMul(a, b) {
    let r = 0;
    while (b) {
        if (b & 1) r ^= a;
        a = aesXtime(a);
        b >>= 1;
    }
    return r;
}

function aesExpandKey(key) {
    const w = key.slice();
    let rcon = 1;
    for (let i = 16; i < 176; i += 4) {
        let t = w.slice(i - 4, i);
        if (i % 16 === 0) {
            t = [AES_SBOX.sbox[t[1]] ^ rcon, AES_SBOX.sbox[t[2]], AES_SBOX.sbox[t[3]], AES_SBOX.sbox[t[0]]];
            rcon = aesXtime(rcon);
        }
        for (let j = 0; j < 4; j++) w[i + j] = w[i + j - 16] ^ t[j];
    }
    return w;
}

function aesDecryptBlock(block, w) {
    let s = block.map((b, i) => b ^ w[160 + i]);
    for (let round = 9; round >= 0; round--) {
        const t = new Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) t[((c + r) % 4) * 4 + r] = s[c * 4 + r];
        }
        s = t.map((b, i) => AES_SBOX.inv[b] ^ w[round * 16 + i]);
        if (round > 0) {
            const m = new Array(16);
            for (let c = 0; c < 4; c++) {
                const [a0, a1, a2, a3] = s.slice(c * 4, c * 4 + 4);
                m[c * 4] = aesMul(a0, 14) ^ aesMul(a1, 11) ^ aesMul(a2, 13) ^ aesMul(a3, 9);
                m[c * 4 + 1] = aesMul(a0, 9) ^ aesMul(a1, 14) ^ aesMul(a2, 11) ^ aesMul(a3, 13);
                m[c * 4 + 2] = aesMul(a0, 13) ^ aesMul(a1, 9) ^ aesMul(a2, 14) ^ aesMul(a3, 11);
                m[c * 4 + 3] = aesMul(a0, 11) ^ aesMul(a1, 13) ^ aesMul(a2, 9) ^ aesMul(a3, 14);
            }
            s = m;
        }
    }
    return s;
}

// v 값의 키·IV는 16진수 글자(ASCII)라 글자 코드가 곧 UTF-8 바이트다
function utf8Bytes(str) {
    return Array.from(str).map((c) => c.charCodeAt(0) & 0xff);
}

function aesCbcDecryptHex(hex, keyStr, ivStr) {
    const data = [];
    for (let i = 0; i + 1 < hex.length; i += 2) data.push(parseInt(hex.substring(i, i + 2), 16));
    const key = utf8Bytes(keyStr);
    let prev = utf8Bytes(ivStr);
    if (key.length !== 16 || prev.length !== 16 || data.length === 0 || data.length % 16 !== 0) return null;
    const w = aesExpandKey(key);
    const out = [];
    for (let i = 0; i < data.length; i += 16) {
        const block = data.slice(i, i + 16);
        const dec = aesDecryptBlock(block, w);
        for (let j = 0; j < 16; j++) out.push(dec[j] ^ prev[j]);
        prev = block;
    }
    const pad = out[out.length - 1];
    if (pad < 1 || pad > 16) return null;
    const text = String.fromCharCode.apply(null, out.slice(0, out.length - pad));
    try {
        return typeof escape === "function" ? decodeURIComponent(escape(text)) : text;
    } catch (e) {
        return text;
    }
}

// 플레이어 주소의 v 값을 풀어 m3u8 주소를 돌려준다. 실패하면 null
function decryptPlayerParam(playerUrl) {
    const m = /[?&]v=([0-9a-fA-F]+)/.exec(playerUrl || "");
    if (!m || m[1].length < 64) return null;
    const v = m[1];
    try {
        const url = aesCbcDecryptHex(v.substring(16, v.length - 16), v.substring(v.length - 16), v.substring(0, 16));
        return url && /^https?:\/\//.test(url.trim()) ? url.trim() : null;
    } catch (e) {
        return null;
    }
}
