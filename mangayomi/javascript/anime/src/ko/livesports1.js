const mangayomiSources = [{
    "name": "실시간스포츠1",
    "lang": "ko",
    "baseUrl": "https://gltv88.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/livesports/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.0",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/livesports1.js"
}];

// 실시간스포츠1 = 굿라이브티비(gltv88.com) 스포츠중계 (2026-10-30 구조 확인)
// 사이트의 "스포츠중계 A·B채널" 화면(/bbs/content.php?co_id=streamA) 안 iframe#player 가 중계 화면(gltv77.r2onframe.com/cli/mobile)
// 중계 화면 글자 안에 경기 목록이 그대로 있음: window.r2onframe.data2 = '[{ssid, chcd, ctgr(종목), leag, name, dttm(세계 표준시 UTC),
// oair(1=방송 중), surl·surl2·surl3(m3u8)}]' → 그대로 읽음 (암호 풀기 없음). 영상 서버(gltv.oncahot.com)는 해외에서 Cloudflare 가 막음
const DEFAULT_BASE_URL = "https://gltv88.com";
const DEFAULT_FRAME = "https://gltv77.r2onframe.com/cli/mobile";
const SITE_RE = /^https:\/\/(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const FRAME_RE = /^https:\/\/[A-Za-z0-9.-]+\/[^\s]*$/;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const THUMB_BASE = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs";

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
// 중계 화면의 종목 값(ctgr) → 이름 (rugby 는 NFL 이면 미식축구)
const CTGR_LABELS = {
    football: "축구", soccer: "축구", basketball: "농구", baseball: "야구", hockey: "하키", tennis: "테니스",
    volleyball: "배구", egames: "e스포츠", esports: "e스포츠", fight: "격투기", handball: "핸드볼",
    golf: "골프", badminton: "배드민턴", tabletennis: "탁구", cricket: "크리켓", racing: "기타",
};
// 끝난 경기로 볼 시간 (시작 후)
const ENDED_HOURS = { "축구": 3, "농구": 3, "배구": 3, "하키": 3, "야구": 5, "미식축구": 5 };
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

// ---------- 화질 나누기 · 선호 화질 ----------
const LIVE_QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// 마스터 m3u8 본문에서 화질별 주소를 뽑음 (높은 화질부터, 2개 이상일 때만)
function liveVariants(url, body) {
    const text = String(body || "").replace(/\r/g, "");
    const re = /#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)/g;
    const seen = {};
    const out = [];
    let m;
    while ((m = re.exec(text))) {
        const h = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
        if (!h || seen[h[1]]) continue;
        seen[h[1]] = true;
        let u = m[2].trim();
        if (!/^https?:\/\//.test(u)) {
            u = u.startsWith("/") ? (/^(https?:\/\/[^/]+)/.exec(url) || [null, ""])[1] + u : url.replace(/[^/]*(?:\?.*)?$/, "") + u;
        }
        out.push({ h: Number(h[1]), u });
    }
    out.sort((a, b) => b.h - a.h);
    return out.length >= 2 ? out : [];
}

// 설정의 선호 화질이 이름에 든 영상을 맨 앞으로 (자동이면 그대로)
function liveQualitySort(list) {
    let want = "자동";
    try {
        const v = new SharedPreferences().get("ls1_quality");
        want = LIVE_QUALITY_CHOICES[Number(v)] || (LIVE_QUALITY_CHOICES.includes(v) ? v : "자동");
    } catch (e) {
        want = "자동";
    }
    if (want === "자동") return list;
    return list.filter((x) => x.quality.includes(` ${want}`)).concat(list.filter((x) => !x.quality.includes(` ${want}`)));
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

    // ================= 설정 =================
    pref(key, def) {
        try {
            const v = new SharedPreferences().get(key);
            return v === null || v === undefined || v === "" ? def : v;
        } catch (e) {
            return def;
        }
    }

    saved(key) {
        try {
            return String(new SharedPreferences().getString(key, "") || "").trim();
        } catch (e) {
            return "";
        }
    }

    save(key, v) {
        try {
            new SharedPreferences().setString(key, v);
        } catch (e) {
            // 저장 실패는 무시
        }
    }

    // 사이트 주소: 직접 지정 > 자동으로 찾은 주소 > 기본 주소
    getBaseUrl() {
        const custom = String(this.pref("ls1_domain", "")).trim().replace(/\/+$/, "");
        if (SITE_RE.test(custom)) return custom;
        const auto = this.saved("ls1_auto_domain");
        return SITE_RE.test(auto) ? auto : DEFAULT_BASE_URL;
    }

    // 중계 화면 주소: 직접 지정 > 사이트 화면에서 찾은 주소 > 기본 주소
    frameUrl() {
        const custom = String(this.pref("ls1_frame", "")).trim();
        if (FRAME_RE.test(custom)) return custom;
        const auto = this.saved("ls1_auto_frame");
        return FRAME_RE.test(auto) ? auto : DEFAULT_FRAME;
    }

    autoOn() {
        return this.pref("ls1_auto_on", true) !== false && this.pref("ls1_auto_on", true) !== "false";
    }

    async get(url, referer) {
        const res = await this.client.get(url, { "Referer": referer, "Accept-Language": "ko-KR,ko;q=0.9" });
        return { code: Number(res.statusCode), body: String(res.body || "") };
    }

    /** 사이트의 중계 A·B 화면에서 중계 화면(iframe#player) 주소를 읽음 */
    async frameFromSite(base) {
        for (const id of ["streamA", "streamB", "stram"]) {
            try {
                const r = await this.get(`${base}/bbs/content.php?co_id=${id}`, `${base}/`);
                if (r.code !== 200) continue;
                const m = /<iframe[^>]*id=["']player["'][^>]*>/i.exec(r.body) || /<iframe[^>]*src=["'](https:\/\/[^"']*\/cli\/[^"']*)["']/i.exec(r.body);
                const src = m ? (/src=["']([^"']+)["']/i.exec(m[0]) || [])[1] : "";
                if (src && FRAME_RE.test(src)) return src;
            } catch (e) {
                // 다음 화면
            }
        }
        return "";
    }

    /** 중계 화면이 안 열리면: 사이트 화면에서 새 중계 화면 주소 → 사이트 주소 번호(gltvN.com)를 바꿔 가며 */
    async discover() {
        const last = Number(this.saved("ls1_auto_at")) || 0;
        if (Date.now() - last < 60000) return null;
        this.save("ls1_auto_at", String(Date.now()));
        const tryBase = async (base) => {
            const f = await this.frameFromSite(base);
            if (!f) return null;
            const r = await this.readFrame(f, base);
            return r ? { base, frame: f } : null;
        };
        let hit = await tryBase(this.getBaseUrl());
        if (!hit) {
            const m = /^https:\/\/(?:www\.)?([a-z]+)(\d+)\.([a-z]{2,6})$/.exec(this.getBaseUrl());
            if (m) {
                const n = Number(m[2]);
                for (const d of [1, 2, 3, 4, 5, 6, 7, 8, -1, -2]) {
                    if (n + d < 1) continue;
                    hit = await tryBase(`https://${m[1]}${n + d}.${m[3]}`);
                    if (hit) break;
                }
            }
        }
        if (!hit) return null;
        if (hit.base !== this.getBaseUrl()) this.save("ls1_auto_domain", hit.base);
        this.save("ls1_auto_frame", hit.frame);
        return hit;
    }

    // ================= 경기 목록 =================
    /** 중계 화면 글자 안의 경기 목록 (window.r2onframe.data2 = '[…]') */
    async readFrame(frame, base) {
        let r;
        try {
            r = await this.get(frame, `${base}/`);
        } catch (e) {
            return null;
        }
        if (r.code !== 200) return null;
        // 작은따옴표 글자를 한 글자씩 읽어 \\ · \' 를 풂 (긴 글자를 정규식으로 읽으면 멈출 수 있음)
        const m = /r2onframe\.data2\s*=\s*'/.exec(r.body);
        if (!m) return null;
        const b = r.body;
        let text = "";
        let i = m.index + m[0].length;
        for (; i < b.length; i++) {
            const c = b[i];
            if (c === "'") break;
            if (c === "\\" && i + 1 < b.length) {
                const n = b[++i];
                text += n === "'" || n === "\\" ? n : "\\" + n;
            } else {
                text += c;
            }
        }
        if (i >= b.length) return null;
        try {
            const list = JSON.parse(text);
            return Array.isArray(list) ? list : null;
        } catch (e) {
            return null;
        }
    }

    async fetchRaw() {
        let list = await this.readFrame(this.frameUrl(), this.getBaseUrl());
        if (!list && this.autoOn()) {
            const hit = await this.discover();
            if (hit) list = await this.readFrame(hit.frame, hit.base);
        }
        if (!list) throw new Error("경기 목록을 받지 못했어요. 사이트 주소가 바뀌었으면 새 주소(예: gltv89.com)를 검색창에 붙여 넣어 주세요.");
        return list;
    }

    sportLabel(o) {
        const c = String(o.ctgr || "").toLowerCase();
        if (c === "rugby") return /NFL|미식/i.test(String(o.leag || "")) ? "미식축구" : "럭비";
        return CTGR_LABELS[c] || (c ? "기타" : "");
    }

    /** "2026-10-30 00:15:00" → ms. 중계 화면의 시각은 세계 표준시(UTC): KBO "09:30" = 한국 18:30, NHL "23:00" = 미국 동부 19:00 */
    startMs(s) {
        const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ""));
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : 0;
    }

    /** 한국 시간 "MM.dd HH:mm" */
    startShort(s) {
        const ms = this.startMs(s);
        if (!ms) return "";
        const d = new Date(ms + 9 * 3600000);
        const two = (n) => String(n).padStart(2, "0");
        return `${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
    }

    async fetchGames(src) {
        const raw = await this.fetchRaw();
        const hide = this.pref("ls1_hide_ended", true) !== false && this.pref("ls1_hide_ended", true) !== "false";
        const now = Date.now();
        const out = [];
        for (const o of raw) {
            if (!o || String(o.actv) === "0") continue;
            const urls = [...new Set([o.surl, o.surl2, o.surl3].map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//.test(u)))];
            const live = String(o.oair) === "1" && urls.length > 0;
            if ((src === SRC_LIVE) !== live) continue;
            const label = this.sportLabel(o);
            const start = this.startMs(o.dttm);
            // 끝난 경기: 시작 후 종목별 시간이 지났는데 아직 방송 중으로 남은 경기
            // 예정으로 남았지만 시작 후 그만큼 지난 경기도 (방송 없이 끝남)
            if (hide && start && now - start > (ENDED_HOURS[label] || 6) * 3600000) continue;
            out.push({
                id: String(o.ssid || o.chcd || ""),
                label,
                league: String(o.leag || "").trim(),
                title: String(o.name || "").replace(/\s+/g, " ").trim(),
                startKey: String(o.dttm || ""),
                start,
                urls,
            });
        }
        return out;
    }

    isAllCat(cat) {
        return cat === ALL_CAT || cat === CHOICE_ALL;
    }

    cardLink(p) {
        let link = `/?src=${p.src}&cat=${encodeURIComponent(p.cat)}&sort=${p.sort}`;
        if (p.q) link += `&q=${encodeURIComponent(p.q)}`;
        return link + "&v=1";
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

    matches(g, p) {
        let catOk;
        if (this.isAllCat(p.cat)) catOk = true;
        else if (p.cat === CAT_OTHER) catOk = !CATEGORY_ORDER.includes(g.label);
        else catOk = g.label === p.cat;
        const q = (p.q || "").toLowerCase();
        const qOk = !q || [g.title, g.league, g.label].some((x) => x.toLowerCase().includes(q));
        return catOk && qOk;
    }

    makeCard(p, games) {
        const n = games ? ` · ${games.filter((g) => this.matches(g, p)).length}경기` : "";
        return { name: this.cardTitle(p) + n, imageUrl: this.thumbUrl(p.cat), link: this.cardLink(p) };
    }

    // 지금 목록에 있는 종목만 카드로
    cardsFor(games, src, sort) {
        const present = {};
        for (const g of games) present[g.label] = true;
        const cards = [this.makeCard({ src, cat: ALL_CAT, sort, q: "" }, games)];
        for (const c of CATEGORY_ORDER) if (present[c]) cards.push(this.makeCard({ src, cat: c, sort, q: "" }, games));
        if (Object.keys(present).some((l) => l && !CATEGORY_ORDER.includes(l))) cards.push(this.makeCard({ src, cat: CAT_OTHER, sort, q: "" }, games));
        return cards;
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return { list: this.cardsFor(await this.fetchGames(SRC_LIVE), SRC_LIVE, SORT_CATEGORY), hasNextPage: false };
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return { list: this.cardsFor(await this.fetchGames(SRC_SOON), SRC_SOON, SORT_TIME), hasNextPage: false };
    }

    async search(query, page, filters) {
        let q = String(query || "").trim();
        // 사이트 주소(https:// 없어도)를 붙여 넣으면: 진짜 사이트면 그 주소로 바꾸고 방송 중 목록
        const site = /^(?:https?:\/\/)?((?:www\.)?[a-z]+\d*\.[a-z]{2,6})\/?$/i.exec(q);
        if (site && /\./.test(q) && !/\s/.test(q)) {
            const base = `https://${site[1].toLowerCase()}`;
            const frame = await this.frameFromSite(base);
            if (!frame || !(await this.readFrame(frame, base))) throw new Error(`${site[1]} 에서 중계 화면을 찾지 못했어요. 주소를 다시 확인해 주세요.`);
            this.save("ls1_auto_domain", base);
            this.save("ls1_auto_frame", frame);
            return this.getPopular(page);
        }
        const fs = (filters || []).filter((f) => f && f.type_name === "SelectFilter");
        const state = (name) => {
            const f = fs.find((x) => x.name === name);
            return f ? Number(f.state) || 0 : 0;
        };
        const src = state("범위") === 1 ? SRC_SOON : SRC_LIVE;
        const choice = CATEGORY_CHOICES[state("종목")] || CHOICE_ALL;
        const sort = state("정렬") === 1 ? SORT_TIME : SORT_CATEGORY;
        const cat = choice === CHOICE_EACH || choice === CHOICE_ALL ? ALL_CAT : choice;
        if (!q && choice === CHOICE_EACH) return { list: this.cardsFor(await this.fetchGames(src), src, sort), hasNextPage: false };
        return { list: [this.makeCard({ src, cat, sort, q }, await this.fetchGames(src))], hasNextPage: false };
    }

    // ================= 상세 (경기 목록) =================
    categoryRank(label) {
        if (!label) return CATEGORY_ORDER.length + 1;
        const i = CATEGORY_ORDER.indexOf(label);
        return i >= 0 ? i : CATEGORY_ORDER.length;
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
            const useEmoji = this.pref("ls1_emoji", true) !== false;
            const showHeaders = this.pref("ls1_headers", true) !== false &&
                p.sort === SORT_CATEGORY && !p.q && (this.isAllCat(p.cat) || p.cat === CAT_OTHER);
            const showStartLive = this.pref("ls1_start", true) !== false && this.pref("ls1_start", true) !== "false";
            let last = null;
            for (const g of ordered) {
                const emoji = useEmoji ? (EMOJI[g.label] || (g.label ? "🏅" : "")) : "";
                if (showHeaders && g.label !== last) {
                    const head = [emoji, g.label || "기타", `(${counts[g.label]})`].filter((x) => x).join(" ");
                    episodes.push({ name: `━━ ${head} ━━`, url: `/play?kind=header&n=${episodes.length}` });
                }
                last = g.label;
                const info = [(!live || showStartLive) && g.startKey ? `시작 ${this.startShort(g.startKey)}` : "", g.league].filter((x) => x).join(" · ");
                const name = !g.label ? g.title : useEmoji ? `${emoji} ${g.title}` : `[${g.label}] ${g.title}`;
                episodes.push({ name, url: `/play?id=${encodeURIComponent(g.id)}&src=${g.src || p.src}`, scanlator: info });
            }
        }
        // 맨 위는 목록을 받은 시각 (한국 시간)
        const kst = new Date(Date.now() + 9 * 3600000);
        const two = (n) => String(n).padStart(2, "0");
        const stamp = `${two(kst.getUTCMonth() + 1)}.${two(kst.getUTCDate())} ${two(kst.getUTCHours())}:${two(kst.getUTCMinutes())}`;
        episodes.unshift({ name: `🕒 ${stamp} 기준 · 오래됐으면 아래로 당겨 새로고침`, url: "/play?kind=header&n=time" });
        return {
            name: this.cardTitle(p),
            imageUrl: this.thumbUrl(p.cat),
            description: `${live ? "방송 중" : "예정"} ${games.length}경기 · 정렬: ${p.sort === SORT_TIME ? "시간순" : "종목순"} · 굿라이브티비`,
            episodes: this.slotify(p, episodes),
            status: 0,
            genre: [],
            link: url,
        };
    }

    // 망가요미는 목록에서 빠진 회차를 지우지 않고 쌓아 둠 → 회차를 "자리"로 씀 (실시간스포츠2 와 같은 방법)
    slotify(p, rows) {
        const key = `ls1_slots_${p.src}_${p.cat}_${p.sort}_${p.q}`;
        const saved = Number(this.saved(key)) || 0;
        const total = Math.max(rows.length, saved);
        if (total !== saved) this.save(key, String(total));
        const plain = (t) => String(t || "").replace(/\b(folge|episode|ep\.?|staffel|season|saison|temporada|s)(\s*\d)/gi, "$1​$2");
        const out = rows.map((r, i) => ({
            name: `${plain(r.name)}${r.scanlator ? ` · ${plain(r.scanlator)}` : ""} · ep${total - i}`,
            url: `${r.url}&slot=${total - i}`,
            scanlator: "",
        }));
        for (let j = rows.length; j < total; j++) out.push({ name: `─ 빈 칸 · ep${total - j}`, url: `/play?kind=empty&n=${total - j}`, scanlator: "" });
        return out;
    }

    // ================= 재생 =================
    async getVideoList(url) {
        return hlsHint(await this.videoListInner(url));
    }

    async videoListInner(url) {
        if (url.includes("kind=header")) throw new Error("구분 줄입니다. 아래의 경기를 선택하세요");
        if (url.includes("kind=none")) throw new Error("선택할 수 있는 경기가 없습니다");
        if (url.includes("kind=empty")) throw new Error("빈 칸입니다. 지금은 이 자리에 경기가 없습니다");
        const id = decodeURIComponent((/[?&]id=([^&]*)/.exec(url) || [])[1] || "");
        if (!id) throw new Error("선택할 수 있는 경기가 없습니다");
        // 재생할 때 목록을 다시 받아 그 경기의 최신 영상 주소를 씀
        const raw = await this.fetchRaw();
        const o = raw.find((x) => x && String(x.ssid || x.chcd || "") === id);
        if (!o) throw new Error("경기 정보를 찾지 못했습니다. 방송이 끝났을 수 있으니 목록을 새로고침하세요");
        const urls = [...new Set([o.surl, o.surl2, o.surl3].map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//.test(u)))];
        if (!urls.length) throw new Error(`아직 방송 전이에요 (시작 ${this.startShort(o.dttm) || "미정"})`);
        const frame = this.frameUrl();
        const fo = (/^(https?:\/\/[^/]+)/.exec(frame) || [null, ""])[1];
        const base = this.getBaseUrl();
        const variants = [
            ["중계 화면", { "Referer": `${fo}/`, "Origin": fo }],
            ["사이트", { "Referer": `${base}/`, "Origin": base }],
            ["UA만", {}],
        ];
        const out = [];
        const log = [];
        for (let i = 0; i < urls.length; i++) {
            const m3u8 = urls[i];
            const suffix = i === 0 ? "" : ` (대체 ${i})`;
            let ok = false;
            for (const [label, extra] of variants) {
                const h = Object.assign({ "User-Agent": UA, "Accept": "*/*" }, extra);
                try {
                    const res = await this.client.get(m3u8, h);
                    const body = String(res.body || "");
                    if (Number(res.statusCode) === 200 && body.trim().startsWith("#EXTM3U")) {
                        const vs = liveVariants(m3u8, body);
                        out.push({ url: m3u8, originalUrl: m3u8, quality: vs.length ? `자동 (최대 ${vs[0].h}p)${suffix}` : `직접${suffix}`, headers: h });
                        for (const v of vs) out.push({ url: v.u, originalUrl: v.u, quality: `${v.h}p${suffix}`, headers: h });
                        ok = true;
                        break;
                    }
                    log.push(`${label}:${res.statusCode}`);
                } catch (e) {
                    log.push(`${label}:오류`);
                }
            }
            // 확인이 안 돼도(영상 서버가 앱 통신을 막는 경우 등) 재생기에 맡겨 봄
            if (!ok) out.push({ url: m3u8, originalUrl: m3u8, quality: `확인 안 됨${suffix} [${log.slice(-3).join(" ")}]`, headers: Object.assign({ "User-Agent": UA }, variants[0][1]) });
        }
        return liveQualitySort(out);
    }

    // ================= 필터 / 설정 =================
    getFilterList() {
        const select = (name, labels) => ({
            type_name: "SelectFilter", name, state: 0,
            values: labels.map((l, i) => ({ type_name: "SelectOption", name: l, value: String(i) })),
        });
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${this.getBaseUrl().replace(/^https?:\/\//, "")} · 중계 ${this.frameUrl().replace(/^https?:\/\//, "").split("/")[0]}` },
            ...notesFilters("livesports1"),
            { type_name: "HeaderFilter", name: "검색창에 팀·대회 이름을 넣으면 그 경기만, 사이트 주소를 붙여 넣으면 그 주소로 바꿔요" },
            select("범위", ["방송 중", "예정"]),
            select("종목", CATEGORY_CHOICES),
            select("정렬", ["종목순", "시간순"]),
        ];
    }

    getSourcePreferences() {
        return [
            {
                key: "ls1_quality",
                listPreference: {
                    title: "선호 화질",
                    summary: "중계가 여러 화질을 제공할 때 이 화질을 먼저 재생합니다.",
                    valueIndex: 0,
                    entries: LIVE_QUALITY_CHOICES,
                    entryValues: LIVE_QUALITY_CHOICES,
                },
            },
            {
                key: "ls1_domain",
                editTextPreference: {
                    title: "사이트 주소 직접 지정 (선택)",
                    summary: "비워 두면 기본 주소(https://gltv88.com) 또는 자동으로 찾은 주소를 사용합니다.",
                    value: "",
                    dialogTitle: "사이트 주소",
                    dialogMessage: "https:// 로 시작하는 주소 (또는 검색창에 붙여 넣기)",
                },
            },
            {
                key: "ls1_frame",
                editTextPreference: {
                    title: "중계 화면 주소 직접 지정 (고급)",
                    summary: "비워 두면 사이트의 중계 화면에서 자동으로 찾습니다.",
                    value: "",
                    dialogTitle: "중계 화면 주소",
                    dialogMessage: "예: https://gltv77.r2onframe.com/cli/mobile",
                },
            },
            {
                key: "ls1_auto_on",
                switchPreferenceCompat: { title: "주소 자동 찾기", summary: "목록을 못 받으면 사이트 화면에서 중계 화면 주소를 다시 찾고, 사이트 주소 번호(gltvN.com)도 바꿔 봅니다.", value: true },
            },
            {
                key: "ls1_headers",
                switchPreferenceCompat: { title: "종목 구분 줄 표시", summary: "전체 경기를 종목순으로 볼 때 종목마다 구분 줄을 넣습니다.", value: true },
            },
            {
                key: "ls1_start",
                switchPreferenceCompat: { title: "시작 시각 표시", summary: "방송 중인 경기 줄에도 시작 시각을 표시합니다. 예정 경기에는 항상 표시됩니다.", value: true },
            },
            {
                key: "ls1_emoji",
                switchPreferenceCompat: { title: "종목 이모지 표시", summary: "끄면 [축구] 형태로 표시합니다.", value: true },
            },
            {
                key: "ls1_hide_ended",
                switchPreferenceCompat: {
                    title: "끝난 경기 숨기기",
                    summary: "시작 후 종목별 시간(축구·농구·하키 3, 야구·미식축구 5, 그 밖 6시간)이 지났는데 방송 중으로 남은 경기는 뺍니다.",
                    value: true,
                },
            },
        ];
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

function notesFilters(key) {
    let list = [];
    try {
        list = (JSON.parse(new SharedPreferences().getString("notes_json", "") || "{}").items || {})[key] || [];
    } catch (e) {
        list = [];
    }
    return list.filter((n) => n && n.t).slice(0, 3)
        .map((n) => ({ type_name: "HeaderFilter", name: `📝 ${String(n.d || "").substring(5).replace("-", ".")} ${n.t}`, _status: true }));
}
