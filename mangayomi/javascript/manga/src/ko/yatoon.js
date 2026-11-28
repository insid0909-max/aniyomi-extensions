const mangayomiSources = [{
    "name": "야툰",
    "id": 1543270650,
    "lang": "ko",
    "baseUrl": "https://yatoon279.asia",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/icon/eu.kanade.tachiyomi.extension.ko.newxtoon.png",
    "typeSource": "single",
    "itemType": 0,
    "isNsfw": true,
    "hasCloudflare": false,
    "version": "0.1.0",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "manga/src/ko/yatoon.js"
}];

// 야툰 (yatoon279.asia, 2026-11-27 구조 확인 · 해외에서도 열림 · 보안 확인 없음)
// - 목록·검색: GET /ajax/webtoon-list.php?fin=ongoing|complete&day=&genre=&company=&sort=latest|popular  (머리글 X-Requested-With: XMLHttpRequest)
//   검색은 keyword= (다른 조건 무시). 한 번에 30개, 쪽 번호 없음 → 응답 머리글 x-webtoon-has-more·next-id·next-last·next-hit 를
//   다음 요청에 cursor_id·cursor_last(최신순·검색)·cursor_hit(인기순)로 넘김 → 쪽마다 저장해 두고 모르는 쪽은 앞에서부터 따라감
//   카드 article.webtoon-card[data-id] (img src, h3, .webtoon-genre, .webtoon-episode-count)
// - 작품: GET /ajax/episode-list.php?id=N → 제목·장르·상태(.episode-status)·회차 a.episode-item[href=/viewer/ID], 50개 넘으면
//   data-has-more=1·data-cursor-id → GET /ajax/episode-more.php?id=N&cursor_id=… → JSON {html,hasMore,nextCursor}
// - 회차: GET /viewer/ID → img src=https://img.yatoon279.asia/data/file/download/img/… (Referer 없이도 열림)
const DEFAULT_BASE_URL = "https://yatoon279.asia";
const DOMAIN_RE = /^https:\/\/(?:www\.)?yatoon\d*\.[a-z]{2,8}$/i;
const LABEL = "야툰";
const DAYS = ["월", "화", "수", "목", "금", "토", "일", "열흘"];
const GENRES = ["학원", "액션", "SF", "스토리", "판타지", "BL/백합", "개그/코미디", "연애/순정", "드라마", "로맨스", "시대극", "스포츠", "일상", "추리/미스터리", "공포/스릴러", "성인", "옴니버스", "에피소드", "무협", "소년", "기타"];
const COMPANIES = [["naver", "네이버"], ["daum", "다음"], ["kakao", "카카오"], ["rejin", "레진"], ["tomics", "투믹스"], ["toptoon", "탑툰"], ["comica", "코미카"], ["battlecomics", "배틀코믹"], ["comicgt", "코믹GT"], ["ktoon", "케이툰"], ["anitoon", "애니툰"], ["foxtoon", "폭스툰"], ["peanutoon", "피너툰"], ["bom", "봄툰"], ["comico", "코미코"], ["mootoon", "무툰"], ["etc", "기타"]];

function first(n, s) { const a = n ? n.select(s) : []; return a.length ? a[0] : null; }
function txt(n) { return String((n && n.text) || "").replace(/\s+/g, " ").trim(); }
function attr(n, k) { return String((n && n.attr(k)) || "").trim(); }
function header(res, name) {
    const h = (res && res.headers) || {};
    for (const k of Object.keys(h)) if (k.toLowerCase() === name) return String(h[k] == null ? "" : h[k]);
    return "";
}
function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
        this.cursors = {};
    }

    getBaseUrl() {
        let v = "";
        try { v = String(new SharedPreferences().get("yatoon_domain") || "").trim().replace(/\/+$/, ""); } catch (e) { v = ""; }
        if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
        return DOMAIN_RE.test(v) ? v : DEFAULT_BASE_URL;
    }

    ajaxHeaders() {
        return { "X-Requested-With": "XMLHttpRequest", "Referer": this.getBaseUrl() + "/" };
    }

    async req(path) {
        const url = this.getBaseUrl() + path;
        let res = null, err = "";
        try { res = await this.client.get(url, this.ajaxHeaders()); } catch (e) { err = String((e && e.message) || e).substring(0, 80); }
        if (!res) throw new Error(`${LABEL} 접속 실패 [${err}] · 설정에서 새 주소(yatoonNNN)를 넣어 주세요`);
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 [HTTP ${res.statusCode} · ${path.split("?")[0]}]`);
        return res;
    }

    cards(html) {
        const doc = new Document(html);
        const list = [], seen = new Set();
        for (const c of doc.select("article.webtoon-card")) {
            const id = attr(c, "data-id") || attr(first(c, "[data-webtoon-id]"), "data-webtoon-id");
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const img = first(c, "img");
            list.push({ name: txt(first(c, "h3")) || attr(img, "alt") || id, imageUrl: this.abs(attr(img, "src")), link: id });
        }
        return list;
    }

    abs(u) { return !u ? "" : /^https?:/.test(u) ? u : this.getBaseUrl() + (u[0] === "/" ? "" : "/") + u; }

    // 쪽 번호가 없는 목록 → 쪽마다 다음 cursor 를 저장
    async listing(params, page) {
        const key = "yt|" + params.sort + "|" + params.keyword + "|" + params.fin + "|" + params.day + "|" + params.genre + "|" + params.company;
        const build = (cur) => {
            const q = [];
            if (params.keyword) { q.push("keyword=" + encodeURIComponent(params.keyword)); q.push("sort=latest"); }
            else {
                q.push("fin=" + params.fin);
                if (params.day) q.push("day=" + encodeURIComponent(params.day));
                if (params.genre) q.push("genre=" + encodeURIComponent(params.genre));
                if (params.company) q.push("company=" + encodeURIComponent(params.company));
                q.push("sort=" + params.sort);
            }
            if (cur) {
                if (cur.id) q.push("cursor_id=" + encodeURIComponent(cur.id));
                if (cur.last && (params.keyword || params.sort !== "popular")) q.push("cursor_last=" + encodeURIComponent(cur.last));
                if (cur.hit && !params.keyword && params.sort === "popular") q.push("cursor_hit=" + encodeURIComponent(cur.hit));
            }
            return "/ajax/webtoon-list.php?" + q.join("&");
        };
        let p = page;
        while (p > 1 && !this.cursors[key + "|" + p]) p--;
        let out = { list: [], hasNextPage: false };
        for (; p <= page; p++) {
            const cur = p === 1 ? null : this.cursors[key + "|" + p];
            if (p > 1 && !cur) return { list: [], hasNextPage: false };
            const res = await this.req(build(cur));
            out = { list: this.cards(String(res.body || "")), hasNextPage: header(res, "x-webtoon-has-more") === "1" };
            const nxt = { id: header(res, "x-webtoon-next-id"), last: dec(header(res, "x-webtoon-next-last")), hit: header(res, "x-webtoon-next-hit") };
            if (out.hasNextPage && nxt.id) this.cursors[key + "|" + (p + 1)] = nxt; else out.hasNextPage = false;
        }
        return out;
    }

    async getPopular(page) { return this.listing({ fin: "ongoing", day: "", genre: "", company: "", sort: "popular", keyword: "" }, page); }
    async getLatestUpdates(page) { return this.listing({ fin: "ongoing", day: "", genre: "", company: "", sort: "latest", keyword: "" }, page); }

    async search(query, page, filters) {
        query = String(query || "").trim();
        const m = /^(?:https?:\/\/)?((?:www\.)?yatoon\d*\.[a-z]{2,8})(\/.*)?$/i.exec(query);
        if (m) {
            try { new SharedPreferences().setString("yatoon_domain", "https://" + m[1].toLowerCase()); } catch (e) { }
            return this.getLatestUpdates(page);
        }
        const p = { fin: "ongoing", day: "", genre: "", company: "", sort: "latest", keyword: query };
        if (!query) {
            for (const f of filters || []) {
                const v = f.values && f.values[f.state] ? f.values[f.state].value : "";
                if (f.type && f.type in p) p[f.type] = v || p[f.type];
            }
        }
        return this.listing(p, page);
    }

    async getDetail(url) {
        const id = (/(\d+)/.exec(String(url)) || [])[1];
        const res = await this.req(`/ajax/episode-list.php?id=${id}`);
        const html = String(res.body || "");
        const doc = new Document(html);
        const name = txt(first(doc, "h1.episode-webtoon-title")) || txt(first(doc, "h1"));
        const imageUrl = this.abs(attr(first(doc, ".episode-cover img"), "src"));
        const statusText = txt(first(doc, ".episode-status"));
        const labels = doc.select(".episode-meta-label").map((x) => txt(x));
        const values = doc.select(".episode-meta-value").map((x) => txt(x));
        const meta = {};
        labels.forEach((l, i) => { meta[l] = values[i] || ""; });
        const genre = String(meta["장르"] || "").split(/[,/·]/).map((x) => x.trim()).filter(Boolean);
        const author = meta["작가"] || meta["글/그림"] || "";
        const desc = txt(first(doc, ".episode-description, .episode-summary-text, .episode-desc"));
        const eps = [];
        const addRows = (d) => {
            for (const a of d.select("a.episode-item")) {
                const eid = attr(a, "data-episode-id") || (/\/viewer\/(\d+)/.exec(attr(a, "href")) || [])[1];
                if (!eid) continue;
                eps.push({ name: txt(first(a, ".episode-item-title")) || eid, url: eid, dateUpload: String(Date.now()), _date: txt(first(a, ".episode-item-date")) });
            }
        };
        addRows(doc);
        let more = attr(first(doc, "#episodeList, .episode-list"), "data-has-more") || (/data-has-more="(\d)"/.exec(html) || [])[1] || "0";
        let cursor = (/data-cursor-id="(\d+)"/.exec(html) || [])[1] || "";
        let guard = 0;
        while (more === "1" && cursor && guard++ < 60) {
            const r = await this.req(`/ajax/episode-more.php?id=${id}&cursor_id=${cursor}`);
            let j = null;
            try { j = JSON.parse(String(r.body || "")); } catch (e) { j = null; }
            if (!j || !j.html) break;
            addRows(new Document(j.html));
            more = j.hasMore ? "1" : "0";
            cursor = String(j.nextCursor || "");
        }
        const rel = (s) => {
            const m = /(\d+)\s*(분|시간|일|개월|달|년)\s*전/.exec(s || "");
            if (!m) return Date.now();
            const n = +m[1], u = { "분": 60e3, "시간": 36e5, "일": 864e5, "개월": 30 * 864e5, "달": 30 * 864e5, "년": 365 * 864e5 }[m[2]];
            return Date.now() - n * u;
        };
        for (const e of eps) { e.dateUpload = String(Math.round(rel(e._date) / 3600000) * 3600000); delete e._date; }
        const seen = new Set();
        const episodes = eps.filter((e) => !seen.has(e.url) && seen.add(e.url));
        return {
            name, imageUrl, link: String(id), genre, author,
            status: /완결/.test(statusText) ? 1 : /연재/.test(statusText) ? 0 : 5,
            description: [author ? `작가: ${author}` : "", desc].filter(Boolean).join("\n"),
            chapters: episodes,
        };
    }

    async getPageList(url) {
        const id = (/(\d+)/.exec(String(url)) || [])[1];
        const path = `/viewer/${id}`;
        let res = null;
        try { res = await this.client.get(this.getBaseUrl() + path, { "Referer": this.getBaseUrl() + "/" }); } catch (e) { throw new Error(`${LABEL} 접속 실패 [${String((e && e.message) || e).substring(0, 80)}]`); }
        if (res.statusCode >= 400) throw new Error(`${LABEL} 회차 접속 실패 [HTTP ${res.statusCode}]`);
        const html = String(res.body || "");
        const out = [], seen = new Set();
        for (const img of new Document(html).select("img")) {
            const src = attr(img, "data-src") || attr(img, "src");
            if (!/\/data\/file\/download\/img\//.test(src) || seen.has(src)) continue;
            seen.add(src);
            out.push(this.abs(src));
        }
        if (!out.length) throw new Error(`${LABEL} 그림을 못 찾았어요 [/viewer/${id}]`);
        return out.map((u) => ({ url: u, headers: { "Referer": this.getBaseUrl() + "/" } }));
    }

    getFilterList() {
        const sel = (type, name, list) => ({ type_name: "SelectFilter", type, name, state: 0,
            values: list.map(([value, nm]) => ({ type_name: "SelectOption", name: nm, value })) });
        return [
            { type_name: "HeaderFilter", name: "검색어가 있으면 필터 무시 · 검색창에 새 주소(yatoonNNN.asia) 붙여 넣기" },
            sel("fin", "연재/완결", [["ongoing", "연재"], ["complete", "완결"]]),
            sel("day", "요일", [["", "전체"], ...DAYS.map((d) => [d, d])]),
            sel("genre", "장르", [["", "전체"], ...GENRES.map((g) => [g, g])]),
            sel("company", "플랫폼", [["", "전체"], ...COMPANIES]),
            sel("sort", "정렬", [["latest", "최신순"], ["popular", "인기순"]]),
        ];
    }

    getSourcePreferences() {
        return [{
            key: "yatoon_domain",
            editTextPreference: { title: "사이트 주소", summary: "주소가 바뀌면 https://yatoonNNN.asia 형식으로 입력 (비우면 기본 주소)", value: "", dialogTitle: "사이트 주소", dialogMessage: DEFAULT_BASE_URL },
        }];
    }
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
