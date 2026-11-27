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
    "version": "0.0.1",
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
