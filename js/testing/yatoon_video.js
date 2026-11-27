const mangayomiSources = [{
    "name": "[시험] 야툰 영상",
    "id": 1543279661,
    "lang": "ko",
    "baseUrl": "https://yatoon279.asia",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/icon/eu.kanade.tachiyomi.extension.ko.newxtoon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": true,
    "hasCloudflare": false,
    "version": "0.0.8",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/yatoon_video.js"
}];

// 야툰 영상 (yatoon279.asia/videos/, 2026-11-27 구조 확인 · 해외에서도 열림)
// - 목록: /videos/?q=검색어&category=(subtitle|uncensored|uhd|mosaic)&sort=(빈값=최신|popular|weekly|likes)&tag=태그&page=N
//   카드 a.video-card[href=/videos/ID] · img src · .video-title · .video-meta, 다음 쪽 = a[href*=page=N+1]
// - 작품: /videos/ID — h1(두 번째) · .video-tags a · .video-extra-field(라벨·값) · .video-extra-chip(출연자)
//   플레이어 iframe src=https://getav.net/ko/embed/{품번} (해외에서 Cloudflare 차단이라 구조 미확인)
// - 재생: ① 플레이어 화면 HTML 에서 m3u8/mp4 찾기 ② 안 되면 웹뷰로 열어 플레이어가 부른 m3u8/mp4 모음
const DEFAULT_BASE_URL = "https://yatoon279.asia";
const DOMAIN_RE = /^https:\/\/(?:www\.)?yatoon\d*\.[a-z]{2,8}$/i;
const LABEL = "야툰 영상";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const CATEGORIES = [["", "전체"], ["subtitle", "자막"], ["uncensored", "무수정"], ["uhd", "초고화질"], ["mosaic", "모자이크"]];
const SORTS = [["", "최신순"], ["popular", "인기순"], ["weekly", "주간 인기"], ["likes", "좋아요순"]];
const TAGS = ["고화질", "단독 작품", "DMM 독점", "질내사정", "거유", "유부녀", "구강성교", "여고생", "분출", "4K", "능욕", "파이즈리", "다자 플레이", "불륜", "여성상위", "음탕녀", "드라마", "아이돌", "난교"];

function first(n, s) { const a = n ? n.select(s) : []; return a.length ? a[0] : null; }
function txt(n) { return String((n && n.text) || "").replace(/\s+/g, " ").trim(); }
function attr(n, k) { return String((n && n.attr(k)) || "").trim(); }

class DefaultExtension extends MProvider {
    constructor() { super(); this.client = new Client(); }

    getBaseUrl() {
        let v = "";
        try { v = String(new SharedPreferences().get("yatoon_video_domain") || "").trim().replace(/\/+$/, ""); } catch (e) { v = ""; }
        if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
        return DOMAIN_RE.test(v) ? v : DEFAULT_BASE_URL;
    }
    getHeaders() { return { "Referer": this.getBaseUrl() + "/" }; }
    abs(u) { if (!u) return ""; if (/^https?:/i.test(u)) return u; if (u.startsWith("//")) return "https:" + u; return this.getBaseUrl() + (u.startsWith("/") ? "" : "/") + u; }

    async get(path) {
        let res = null, err = "";
        try { res = await this.client.get(this.abs(path), this.getHeaders()); } catch (e) { err = String((e && e.message) || e).substring(0, 80); }
        if (!res) throw new Error(`${LABEL} 접속 실패 [${err}] · 설정에서 새 주소(yatoonNNN)를 넣어 주세요`);
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 [HTTP ${res.statusCode}]`);
        return res.body;
    }

    async listing(params, page) {
        const q = Object.keys(params).filter((k) => params[k]).map((k) => `${k}=${encodeURIComponent(params[k])}`);
        if (page > 1) q.push(`page=${page}`);
        const html = await this.get("/videos/" + (q.length ? "?" + q.join("&") : ""));
        const doc = new Document(html);
        const list = [], seen = new Set();
        for (const a of doc.select("a.video-card")) {
            const id = attr(a, "data-video-id") || ((/\/videos\/(\d+)/.exec(attr(a, "href")) || [])[1]);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            list.push({ name: txt(first(a, ".video-title")) || id, imageUrl: this.abs(attr(first(a, "img"), "src")), link: `/videos/${id}` });
        }
        const hasNextPage = new RegExp(`[?&]page=${page + 1}(?!\\d)`).test(html);
        return { list, hasNextPage };
    }

    async getPopular(page) { return this.listing({ sort: "popular" }, page); }
    async getLatestUpdates(page) { return this.listing({}, page); }

    async search(query, page, filters) {
        query = String(query || "").trim();
        const m = /yatoon\d*\.[a-z]{2,8}/i.exec(query);
        if (m) throw new Error(`설정 > 사이트 주소에 https://${m[0]} 를 넣어 주세요`);
        const val = (f) => (f && f.values && f.values[f.state]) ? f.values[f.state].value : "";
        const p = { q: query };
        for (const f of (filters || [])) {
            if (f.type === "cat") p.category = val(f);
            if (f.type === "sort") p.sort = val(f);
            if (f.type === "tag") p.tag = val(f);
        }
        return this.listing(p, page);
    }

    async getDetail(url) {
        const link = /^\d+$/.test(url) ? `/videos/${url}` : url.replace(/^https?:\/\/[^/]+/, "");
        const doc = new Document(await this.get(link));
        const box = first(doc, ".video-detail") || doc;
        const h1s = box.select("h1").map(txt).filter((t) => t && t !== "성인 영상");
        const name = h1s[0] || txt(first(doc, "title")).replace(/\s*-\s*야툰\s*$/, "");
        const iframe = first(box, ".video-player iframe") || first(box, "iframe");
        const player = this.abs(attr(iframe, "src"));
        const genre = box.select(".video-tags a").map((a) => txt(a).replace(/^#/, "")).filter(Boolean);
        const info = [];
        for (const f of box.select(".video-extra-field")) {
            const k = txt(first(f, ".video-extra-label")), v = txt(f).replace(k, "").trim();
            if (k && v) info.push(`${k}: ${v}`);
        }
        const stars = box.select(".video-extra-chip").map(txt).filter(Boolean);
        if (stars.length) info.push(`출연자: ${stars.join(", ")}`);
        const og = attr(first(doc, 'meta[property="og:image"]'), "content");
        const code = (/^([A-Z0-9]+-\d+)/i.exec(name) || [])[1] || "";
        return {
            name, link, genre, status: 1,
            imageUrl: this.abs(og),
            description: info.join("\n"),
            episodes: player ? [{ name: "1. 본편", url: link, dateUpload: String(Date.now()) }] : [],
        };
    }

    findMedia(html) {
        const s = String(html || "").replace(/\\\//g, "/");
        const out = [];
        const re = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/gi;
        let m;
        while ((m = re.exec(s))) if (!/_preview\.mp4/i.test(m[0]) && out.indexOf(m[0]) < 0) out.push(m[0]);
        out.sort((a, b) => (/m3u8/i.test(b) ? 1 : 0) - (/m3u8/i.test(a) ? 1 : 0));
        return out;
    }

    async capture(player) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        const script = "(function(){var n=0;function found(){var r=performance.getEntriesByType('resource'),o=[];" +
            "for(var i=0;i<r.length;i++){var u=r[i].name;if((/\\.(m3u8|mp4|m4v|webm)(\\?|$)|\\/(hls|playlist|manifest|master)[^\\/]*$/.test(u)||r[i].initiatorType==='video')&&!/_preview\\.mp4/.test(u)&&o.indexOf(u)<0)o.push(u);}" +
            "var v=document.querySelector('video');var s=v&&(v.currentSrc||v.src);if(s&&/^https?:/.test(s)&&o.indexOf(s)<0)o.push(s);return o;}" +
            "var t=setInterval(function(){n++;var o=found();var v0=document.querySelector('video');var du=v0?v0.duration:0;if((o.length&&n>=2&&du>=120)||(o.length&&n>=40&&!(du>0))||(o.length&&n>=96)||n>=100){clearInterval(t);" +
            "if(!o.length){var h=document.documentElement.outerHTML.replace(/\\\\\\//g,'/').match(/https?:[^\"'\\s<>\\\\]+?\\.(m3u8|mp4)[^\"'\\s<>\\\\]*/g)||[];for(var k=0;k<h.length;k++)if(!/_preview\\.mp4/.test(h[k])&&o.indexOf(h[k])<0)o.push(h[k]);}" +
            "window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({list:o,href:location.href,title:document.title,len:document.documentElement.outerHTML.length,ifr:document.querySelectorAll('iframe').length,vid:document.querySelectorAll('video').length,vs:String((document.querySelector('video')||{}).currentSrc||(document.querySelector('video')||{}).src||'').substring(0,120),rs:performance.getEntriesByType('resource').map(function(x){return x.initiatorType+':'+x.name}).filter(function(x){return !/\\.(css|js|png|jpe?g|gif|svg|woff2?|ico)(\\?|$)/.test(x)}).slice(-6)}));return;}" +
            "if(n===2||n===6||n===12||n===20||n===40||n===80){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.vjs-big-play-button,.plyr__control--overlaid,.jw-icon-display,.art-state,[class*=play]');if(b)b.click();}},250);})();";
        const timeout = new Promise((r) => setTimeout(() => r(null), 40000));
        try {
            const res = await Promise.race([evaluateJavascriptViaWebview(player, this.getHeaders(), [script]), timeout]);
            return res ? JSON.parse(String(res)) : null;
        } catch (e) { return null; }
    }


    // m3u8 총 길이(초). 마스터면 첫 화질 목록으로 들어가 계산. 못 읽으면 -1
    async duration(u, headers, depth) {
        try {
            const res = await this.client.get(u, headers);
            if (res.statusCode >= 400) return -1;
            const t = String(res.body || "");
            if (/#EXT-X-STREAM-INF/.test(t) && !depth) {
                const m = /#EXT-X-STREAM-INF[^\n]*\n([^\n#][^\n]*)/.exec(t);
                if (!m) return -1;
                return this.duration(new URL(m[1].trim(), u).href, headers, 1);
            }
            let sum = 0, re = /#EXTINF:([\d.]+)/g, x;
            while ((x = re.exec(t))) sum += parseFloat(x[1]);
            return sum > 0 ? sum : -1;
        } catch (e) { return -1; }
    }

    async getVideoList(url) {
        let player = "";
        if (/^\{/.test(String(url))) { try { player = JSON.parse(url).player; } catch (e) { player = ""; } }
        if (!player) {
            const doc = new Document(await this.get(url.replace(/^https?:\/\/[^/]+/, "")));
            player = this.abs(attr(first(doc, ".video-player iframe") || first(doc, "iframe"), "src"));
        }
        if (!player) throw new Error("플레이어 주소를 못 찾았어요");
        const origin = (/^https?:\/\/[^/]+/.exec(player) || [""])[0];
        let list = [], why = "", diag = "";
        if (!DefaultExtension.skipDirect) try {
            const res = await this.client.get(player, { "User-Agent": UA, "Referer": this.getBaseUrl() + "/", "Origin": this.getBaseUrl(), "Accept": "text/html,*/*" });
            if (res.statusCode >= 400) { why = `플레이어 HTTP ${res.statusCode}`; if (res.statusCode === 403) DefaultExtension.skipDirect = true; }
            else list = this.findMedia(res.body);
            if (!list.length && !why) why = "플레이어 화면에 영상 주소 없음";
        } catch (e) { why = "플레이어 접속 실패"; }
        if (!list.length) {
            const info = await this.capture(player);
            list = ((info && info.list) || []).filter((u) => /^https?:\/\//.test(u));
            if (!list.length) {
                why += info ? " · 웹뷰도 주소 못 찾음" : " · 웹뷰 응답 없음";
                if (info) diag = ` · 웹뷰 화면 제목="${String(info.title || "").substring(0, 30)}" 길이=${info.len} iframe=${info.ifr} video=${info.vid} src=${info.vs || "없음"} 요청=${(info.rs || []).map((x) => String(x).substring(0, 90)).join(" | ")}`;
            }
        }
        if (!list.length) throw new Error(`영상 주소를 못 찾았어요 [${why}${diag}]`);
        const headers = { "User-Agent": UA, "Referer": origin + "/", "Origin": origin, "Accept": "*/*" };
        const all = list;
        list = list.filter((u) => !/(^|[/_.-])(ads?|adv|vast|promo|banner|preroll)([/_.?-]|$)/i.test(u));
        if (!list.length) list = all;
        const rows = [];
        for (const u of list.slice(0, 8)) {
            const sec = /m3u8/i.test(u) ? await this.duration(u, headers, 0) : -1;
            rows.push({ u, sec });
        }
        // 긴 것 먼저(광고는 보통 30초 안쪽), 길이를 모르는 것은 뒤로
        rows.sort((a, b) => b.sec - a.sec);
        const fmt = (sec) => sec > 0 ? ` ${Math.floor(sec / 60)}분${Math.round(sec % 60)}초` : "";
        return rows.map((r, i) => ({ url: r.u, originalUrl: r.u,
            quality: `${LABEL}${/m3u8/i.test(r.u) ? " HLS" : " MP4"}${fmt(r.sec)}${r.sec > 0 && r.sec < 60 ? " (광고?)" : ""}${i ? " #" + (i + 1) : ""}`,
            headers, subtitles: [] }));
    }

    getFilterList() {
        const sel = (type, name, list) => ({ type_name: "SelectFilter", type, name, state: 0,
            values: list.map(([value, nm]) => ({ type_name: "SelectOption", name: nm, value })) });
        return [
            { type_name: "HeaderFilter", name: "검색어와 필터를 같이 쓸 수 있어요" },
            sel("cat", "분류", CATEGORIES),
            sel("sort", "정렬", SORTS),
            sel("tag", "태그", [["", "선택 안 함"], ...TAGS.map((t) => [t, t])]),
        ];
    }

    getSourcePreferences() {
        return [{
            key: "yatoon_video_domain",
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
