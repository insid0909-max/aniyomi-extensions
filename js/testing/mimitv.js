const mangayomiSources = [{
    "name": "[시험] 미미티비",
    "id": 1543279658,
    "lang": "ko",
    "baseUrl": "https://mimitv16.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.0.2",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/mimitv.js"
}];

// 미미티비 (2026-11-27 구조 확인, 해외에서도 열림 · 보안 확인 없음)
// - 목록: /show.php?tid={분류}&order_type=(빈값=최신|vod_hits=인기)&limit=24&page=N (카드 .item a.poster[href=shplay.php?id=] · img data-src · h3 a.title)
// - 장르: /show.php?class={장르}&page=N, 검색: /search.php?keyword=검색어&limit=24&page=N
// - 작품: /shplay.php?id=N — h1.entry-title · .poster img data-src · .desc · .meta(국가·장르·연도)
//   회차: 화면 글자 var manualSeasons=[{"e":[{link_1,host_1(회차 이름),link_2…}]}]
// - 재생: link_1 = xiaoca.top/one/onet.php?url=…(플레이어 화면). 실제 주소는 플레이어가 숨겨 둔 값이라 풀지 않고,
//   플레이어 화면을 웹뷰로 열어 플레이어가 받은 …/hls/….m3u8(서명 주소)을 모음. 재생 머리글 Referer https://xiaoca.top/ (없으면 403)
//   자막: 주소 안 "?srt" 뒤 .srt
const DEFAULT_BASE_URL = "https://mimitv16.com";
const DOMAIN_RE = /^https:\/\/(?:www\.)?mimitv\d*\.[a-z]{2,8}$/i;
const LABEL = "미미티비";

const CATEGORIES = [
    ["2", "드라마"], ["42", "한국드라마"], ["43", "해외드라마"], ["44", "숏드라마"],
    ["1", "영화"], ["40", "한국영화"], ["41", "해외영화"],
    ["3", "예능"], ["4", "시사다큐"], ["5", "애니"],
];
const GENRES = ["액션", "코미디", "로맨스", "스릴러", "공포", "범죄", "미스터리", "판타지", "SF", "모험", "가족", "전쟁", "서사",
    "다큐멘터리", "버라이어티", "요리", "시상식", "공연", "웹드라마"];

function first(n, s) { const a = n ? n.select(s) : []; return a.length ? a[0] : null; }
function txt(n) { return String((n && n.text) || "").replace(/\s+/g, " ").trim(); }
function attr(n, k) { return String((n && n.attr(k)) || "").trim(); }

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getBaseUrl() {
        let v = "";
        try { v = String(new SharedPreferences().get("mimi_domain") || "").trim().replace(/\/+$/, ""); } catch (e) { v = ""; }
        if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
        return DOMAIN_RE.test(v) ? v : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "Referer": `${this.getBaseUrl()}/` };
    }

    async get(path) {
        const url = /^https?:/.test(path) ? path : this.getBaseUrl() + path;
        let res = null, err = "";
        try { res = await this.client.get(url, this.getHeaders(url)); } catch (e) { err = String((e && e.message) || e).substring(0, 80); }
        if (!res) throw new Error(`${LABEL} 접속 실패 [${err}] · 설정에서 새 주소(mimitvNN)를 넣어 주세요`);
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 [HTTP ${res.statusCode}]`);
        return String(res.body || "");
    }

    parseList(html, page) {
        const doc = new Document(html);
        const list = [], seen = new Set();
        for (const a of doc.select(".item a.poster")) {
            const id = (/shplay\.php\?id=(\d+)/.exec(attr(a, "href")) || [])[1];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const img = first(a, "img");
            list.push({ name: attr(img, "alt") || id, imageUrl: attr(img, "data-src") || attr(img, "src"), link: `/shplay.php?id=${id}` });
        }
        const hasNextPage = new RegExp(`[?&]page=${page + 1}(?:\\D|$)`).test(html.replace(/&amp;/g, "&"));
        return { list, hasNextPage };
    }

    async listing(query, page) {
        // 사이트 첫 쪽은 page 없음(=0), 다음 쪽은 page=2,3…
        const p = page > 1 ? `&page=${page}` : "";
        return this.parseList(await this.get(`/${query}&limit=24${p}`), page);
    }

    async getPopular(page) { return this.listing("show.php?tid=2&order_type=vod_hits", page); }
    async getLatestUpdates(page) { return this.listing("show.php?tid=2&order_type=", page); }

    async search(query, page, filters) {
        query = String(query || "").trim();
        const m = /^(?:https?:\/\/)?((?:www\.)?mimitv\d*\.[a-z]{2,8})(\/.*)?$/i.exec(query);
        if (m) {
            try { new SharedPreferences().setString("mimi_domain", "https://" + m[1].toLowerCase()); } catch (e) { }
            const id = (/shplay\.php\?id=(\d+)/.exec(m[2] || "") || [])[1];
            if (id) { const d = await this.getDetail(`/shplay.php?id=${id}`); return { list: [{ name: d.name, imageUrl: d.imageUrl, link: d.link }], hasNextPage: false }; }
            return this.getLatestUpdates(page);
        }
        if (query) return this.listing(`search.php?keyword=${encodeURIComponent(query)}`, page);
        let cat = "2", order = "", genre = "";
        for (const f of filters || []) {
            const v = f.values && f.values[f.state] ? f.values[f.state].value : "";
            if (f.type === "cat") cat = v || cat;
            if (f.type === "order") order = v;
            if (f.type === "genre") genre = v;
        }
        if (genre) return this.listing(`show.php?class=${encodeURIComponent(genre)}`, page);
        return this.listing(`show.php?tid=${cat}&order_type=${order}`, page);
    }

    async getDetail(url) {
        const id = (/id=(\d+)/.exec(url) || [])[1];
        const link = `/shplay.php?id=${id}`;
        const html = await this.get(link);
        const doc = new Document(html);
        const sec = first(doc, "section.info") || doc;
        const name = txt(first(sec, "h1.entry-title")) || txt(first(doc, "h1"));
        const imageUrl = attr(first(sec, ".poster img"), "data-src");
        const desc = txt(first(sec, ".desc"));
        const meta = {};
        for (const row of sec.select(".meta > div")) {
            const s = row.select("span");
            if (s.length >= 2) meta[txt(s[0]).replace(/:$/, "")] = txt(s[1]);
        }
        const genre = String(meta["장르"] || "").split(",").map((x) => x.trim()).filter(Boolean);
        const year = (/(?:19|20)\d{2}/.exec(meta["연도"] || "") || [])[0] || "";
        let seasons = [];
        try { seasons = JSON.parse((/var\s+manualSeasons\s*=\s*(\[[\s\S]*?\]);\s*;?\s*<\/script>/.exec(html) || [])[1] || "[]"); } catch (e) { seasons = []; }
        const episodes = [];
        seasons.forEach((s, si) => {
            for (const e of s.e || []) {
                const links = [1, 2, 3].map((i) => e["link_" + i]).filter((x) => /^https?:/.test(String(x || "")));
                if (!links.length) continue;
                const nm = String(e.host_1 || "").trim() || "재생";
                episodes.push({ name: (seasons.length > 1 ? `시즌${si + 1} ` : "") + nm, url: JSON.stringify(links), dateUpload: null });
            }
        });
        const movie = genre.some((g) => /영화/.test(g)) || (episodes.length === 1 && !/\d+\s*[화회]/.test(episodes[0].name));
        if (movie) episodes.forEach((e, i) => { e.name = `${i + 1}. 본편`; });
        return {
            name: year && movie && !/\(\d{4}\)$/.test(name) ? `${name} (${year})` : name,
            imageUrl, link, genre,
            status: movie ? 1 : 5,
            description: [meta["국가"] ? `국가: ${meta["국가"]}` : "", year ? `연도: ${year}` : "", desc].filter(Boolean).join("\n"),
            episodes,
        };
    }

    async capture(player) {
        if (typeof evaluateJavascriptViaWebview !== "function") throw new Error("이 망가요미 버전은 웹뷰 재생을 지원하지 않아요.");
        // 플레이어 화면을 그대로 열고, 플레이어가 불러온 m3u8 을 모음 (사이트 코드 풀기 안 함)
        const script = "(function(){var n=0;function found(){var r=performance.getEntriesByType('resource'),o=[];" +
            "for(var i=0;i<r.length;i++){if(/\\.m3u8(\\?|$)/.test(r[i].name)&&o.indexOf(r[i].name)<0)o.push(r[i].name);}" +
            "var v=document.querySelector('video');var s=v&&(v.currentSrc||v.src);if(s&&/^https?:/.test(s)&&o.indexOf(s)<0)o.push(s);return o;}" +
            "var t=setInterval(function(){n++;var o=found();if((o.length&&n>=2)||n>=60){clearInterval(t);" +
            "window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({list:o,href:location.href}));return;}" +
            "if(n===8||n===20){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.art-state,.art-control-play');if(b)b.click();}},250);})();";
        const timeout = new Promise((r) => setTimeout(() => r(null), 20000));
        let info = null;
        try {
            const res = await Promise.race([evaluateJavascriptViaWebview(player, { "Referer": `${this.getBaseUrl()}/` }, [script]), timeout]);
            info = res ? JSON.parse(String(res)) : null;
        } catch (e) { info = null; }
        return info;
    }

    async getVideoList(url) {
        let links = [];
        try { links = JSON.parse(url); } catch (e) { links = [url]; }
        const out = [];
        let last = "웹뷰 응답 없음";
        for (let i = 0; i < links.length; i++) {
            const player = links[i];
            const srt = (/[?&]srt(https?:\/\/[^&#]+\.srt)/i.exec(player) || [])[1];
            const subtitles = srt ? [{ file: srt, label: "한국어" }] : [];
            const info = await this.capture(player);
            const origin = (/^https?:\/\/[^/]+/.exec((info && info.href) || player) || [""])[0];
            const headers = { "Referer": origin + "/", "Origin": origin };
            const list = ((info && info.list) || []).filter((u) => /^https?:\/\//.test(u));
            if (!list.length) { last = info ? "플레이어가 영상 주소를 안 불렀어요" : last; continue; }
            // 서명된 /hls/ 주소를 앞으로 (?url= 의 원래 주소는 직접 열면 404)
            list.sort((a, b) => (/\/hls\//.test(b) ? 1 : 0) - (/\/hls\//.test(a) ? 1 : 0));
            const u = list[0];
            out.push({ url: u, originalUrl: u, quality: `${LABEL} 서버${links.length > 1 ? i + 1 : ""}`, headers, subtitles });
            break;
        }
        if (!out.length) throw new Error(`영상 주소를 못 찾았어요 [${last}]`);
        return out;
    }

    getFilterList() {
        const sel = (type, name, list) => ({ type_name: "SelectFilter", type, name, state: 0,
            values: list.map(([value, nm]) => ({ type_name: "SelectOption", name: nm, value })) });
        return [
            { type_name: "HeaderFilter", name: "검색어가 있으면 필터 무시 · 검색창에 새 주소(mimitvNN.com) 붙여 넣기" },
            sel("cat", "분류", CATEGORIES),
            sel("order", "정렬", [["", "최신순"], ["vod_hits", "인기순"]]),
            sel("genre", "장르 (고르면 분류 무시)", [["", "선택 안 함"], ...GENRES.map((g) => [g, g])]),
        ];
    }

    getSourcePreferences() {
        return [{
            key: "mimi_domain",
            editTextPreference: { title: "사이트 주소", summary: "주소가 바뀌면 https://mimitvNN.com 형식으로 입력 (비우면 기본 주소)", value: "", dialogTitle: "사이트 주소", dialogMessage: DEFAULT_BASE_URL },
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

// ---------- HLS 힌트 (정식판 hlsHint 와 같은 코드) ----------
// .m3u8 로 안 끝나는 HLS(.txt·/hls/·/m3/·master·playlist)는 originalUrl 끝에 "#download.m3u8" — 망가요미 재생기가 HLS 로 알아봄
(function () {
    const hint = (list) => {
        for (const v of list || []) {
            if (!v || !v.url) continue;
            const plain = String(v.url).replace(/#.*$/, "");
            const path = plain.split("?")[0];
            const hlsLike = /\.txt$|\/hls\/|\/m3\/|master|playlist|jmp2\.uk\/stvp-/i.test(path);
            if (/^https?:\/\//.test(plain) && hlsLike && !/\.(?:m3u8?|mp4|mkv|webm|mov|m4v|ts|flv|avi|mp3|aac)$/i.test(path)) v.originalUrl = plain + "#download.m3u8";
        }
        return list;
    };
    const base = DefaultExtension.prototype.getVideoList;
    DefaultExtension.prototype.getVideoList = async function () { return hint(await base.apply(this, arguments)); };
})();
