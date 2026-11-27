const mangayomiSources = [{
    "name": "[시험] 망가토끼",
    "id": 1543279660,
    "lang": "ko",
    "baseUrl": "https://mg.mangatoki2.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/icon/eu.kanade.tachiyomi.extension.ko.newxtoon.png",
    "typeSource": "single",
    "itemType": 0,
    "isNsfw": true,
    "hasCloudflare": false,
    "version": "0.0.1",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "manga/src/ko/mangatoki.js"
}];

// 망가토끼 (mg.mangatoki2.com, 2026-11-27 구조 확인 · 해외에서도 열림 · 보안 확인 없음, Next.js + JSON API)
// - 목록: GET /api/manga?page=N&limit=30&sort=created_at|week|month|view|oldest|random(&seed=)  → {posts:[{id,title,image,tags,view,created_at}], total}
// - 검색: GET /api/manga/search?type=title|artist|character|tag|all&q=…&page=N&limit=30&sort=…  (같은 모양)
// - 작품: GET /api/manga/{id} → {id,title,image,images:[…],tags,view,created_at}  (한 작품 = 한 권, 회차 하나)
// - 그림: https://img.mangatoki2.com{경로} (avif, Referer 없이 열림)
// - 사이트 이름은 "Romaji | 한국어" → 한글 부분이 있으면 그것을 제목으로
// - 미성년자 성적 묘사(lolicon·shotacon 태그) 작품은 목록·검색·상세에서 제외 (사용자 저장소 규칙: 위험 자료 제외)
const DEFAULT_BASE_URL = "https://mg.mangatoki2.com";
const IMG_BASE = "https://img.mangatoki2.com";
const DOMAIN_RE = /^https:\/\/(?:[a-z0-9-]+\.)?mangatoki\d*\.[a-z]{2,8}$/i;
const LABEL = "망가토끼";
const PER = 30;
const BLOCK = /(^|:)(lolicon|shotacon|loli|shota)$/i;

// 응답에 charset 이 없어 한글이 깨져 올 수 있음(Latin-1 로 읽힌 UTF-8) → 모든 글자가 0~255 이고 UTF-8 로 풀리면 풀어서 씀
function fixUtf8(s) {
    s = String(s || "");
    if (!/[\u0080-\u00ff]/.test(s)) return s;
    const out = [];
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 255) return s;
        out.push(c);
    }
    let r = "";
    for (let i = 0; i < out.length;) {
        const b = out[i];
        let n = 0, cp = 0;
        if (b < 0x80) { r += String.fromCharCode(b); i++; continue; }
        else if (b >= 0xc2 && b <= 0xdf) { n = 1; cp = b & 0x1f; }
        else if (b >= 0xe0 && b <= 0xef) { n = 2; cp = b & 0x0f; }
        else if (b >= 0xf0 && b <= 0xf4) { n = 3; cp = b & 0x07; }
        else return s;
        for (let k = 1; k <= n; k++) {
            const x = out[i + k];
            if (x === undefined || (x & 0xc0) !== 0x80) return s;
            cp = (cp << 6) | (x & 0x3f);
        }
        r += String.fromCodePoint(cp);
        i += n + 1;
    }
    return r;
}

function titleOf(t) {
    t = String(t || "").trim();
    const parts = t.split("|").map((x) => x.trim()).filter(Boolean);
    const ko = parts.filter((x) => /[가-힣]/.test(x));
    return ko.length ? ko[ko.length - 1] : (parts[0] || t);
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getBaseUrl() {
        let v = "";
        try { v = String(new SharedPreferences().get("mangatoki_domain") || "").trim().replace(/\/+$/, ""); } catch (e) { v = ""; }
        if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
        return DOMAIN_RE.test(v) ? v : DEFAULT_BASE_URL;
    }

    async json(path) {
        const url = this.getBaseUrl() + path;
        let res = null, err = "";
        try { res = await this.client.get(url, { "Referer": this.getBaseUrl() + "/", "Accept": "application/json" }); } catch (e) { err = String((e && e.message) || e).substring(0, 80); }
        if (!res) throw new Error(`${LABEL} 접속 실패 [${err}] · 설정에서 새 주소를 넣어 주세요`);
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 [HTTP ${res.statusCode} · ${path.split("?")[0]}]`);
        try { return JSON.parse(fixUtf8(res.body)); } catch (e) { throw new Error(`${LABEL} 응답을 읽지 못했어요 [${path.split("?")[0]}]`); }
    }

    img(p) {
        p = String(p || "");
        if (!p) return "";
        if (/^https?:/.test(p)) return p;
        return IMG_BASE + encodeURI(p).replace(/%25/g, "%");
    }

    blocked(tags) { return (tags || []).some((t) => BLOCK.test(String(t))); }

    async listing(path, page) {
        const d = await this.json(path);
        const list = [];
        for (const p of d.posts || []) {
            if (this.blocked(p.tags)) continue;
            list.push({ name: titleOf(p.title), imageUrl: this.img(p.image), link: String(p.id) });
        }
        return { list, hasNextPage: page * PER < Number(d.total || 0) };
    }

    sortPath(sort) { return sort === "random" ? `random&seed=${Math.floor(Date.now() / 3600000)}` : sort; }

    async getPopular(page) { return this.listing(`/api/manga?page=${page}&limit=${PER}&sort=view`, page); }
    async getLatestUpdates(page) { return this.listing(`/api/manga?page=${page}&limit=${PER}&sort=created_at`, page); }

    async search(query, page, filters) {
        query = String(query || "").trim();
        const m = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)?mangatoki\d*\.[a-z]{2,8})(\/.*)?$/i.exec(query);
        if (m) {
            try { new SharedPreferences().setString("mangatoki_domain", "https://" + m[1].toLowerCase()); } catch (e) { }
            return this.getLatestUpdates(page);
        }
        let sort = "created_at", type = "title";
        for (const f of filters || []) {
            const v = f.values && f.values[f.state] ? f.values[f.state].value : "";
            if (f.type === "sort" && v) sort = v;
            if (f.type === "kind" && v) type = v;
        }
        const s = this.sortPath(sort);
        if (query) return this.listing(`/api/manga/search?type=${type}&q=${encodeURIComponent(query)}&page=${page}&limit=${PER}&sort=${s}`, page);
        return this.listing(`/api/manga?page=${page}&limit=${PER}&sort=${s}`, page);
    }

    async getDetail(url) {
        const id = (/(\d+)/.exec(String(url)) || [])[1];
        const d = await this.json(`/api/manga/${id}`);
        if (!d || !d.id) throw new Error(`${LABEL} 작품을 찾지 못했어요 [${id}]`);
        if (this.blocked(d.tags)) throw new Error("미성년자 성적 묘사 태그가 있는 작품은 열지 않습니다.");
        const tags = (d.tags || []).map(String);
        const val = (k) => tags.filter((t) => t.indexOf(k + ":") === 0).map((t) => t.slice(k.length + 1).replace(/_/g, " "));
        const author = val("artist").join(", ");
        const time = Date.parse(String(d.created_at || "").replace(/\.\d+Z$/, "Z")) || Date.now();
        const genre = tags.filter((t) => !/^(artist|group|series|character|type|language):/.test(t)).map((t) => t.replace(/^[a-z]+:/, "").replace(/_/g, " ")).slice(0, 40);
        const lines = [];
        if (String(d.title || "").indexOf("|") >= 0) lines.push(String(d.title));
        if (val("series").length) lines.push("시리즈: " + val("series").join(", "));
        if (val("character").length) lines.push("캐릭터: " + val("character").slice(0, 12).join(", "));
        if (val("group").length) lines.push("서클: " + val("group").join(", "));
        lines.push(`${(d.images || []).length}쪽 · 조회 ${d.view || 0}`);
        return {
            name: titleOf(d.title), imageUrl: this.img(d.image), link: String(d.id), author, genre, status: 1,
            description: lines.join("\n"),
            chapters: [{ name: `본편 (${(d.images || []).length}쪽)`, url: String(d.id), dateUpload: String(time) }],
        };
    }

    async getPageList(url) {
        const id = (/(\d+)/.exec(String(url)) || [])[1];
        const d = await this.json(`/api/manga/${id}`);
        if (this.blocked(d.tags)) throw new Error("미성년자 성적 묘사 태그가 있는 작품은 열지 않습니다.");
        const imgs = (d.images || []).map((p) => this.img(p)).filter(Boolean);
        if (!imgs.length) throw new Error(`${LABEL} 그림이 없어요 [${id}]`);
        return imgs.map((u) => ({ url: u, headers: { "Referer": this.getBaseUrl() + "/" } }));
    }

    getFilterList() {
        const sel = (type, name, list) => ({ type_name: "SelectFilter", type, name, state: 0,
            values: list.map(([value, nm]) => ({ type_name: "SelectOption", name: nm, value })) });
        return [
            { type_name: "HeaderFilter", name: "검색창에 새 주소(mangatokiN.com) 붙여 넣기 · lolicon·shotacon 태그 작품은 제외" },
            sel("sort", "정렬", [["created_at", "최신순"], ["week", "주간 BEST"], ["month", "월간 BEST"], ["view", "조회수순"], ["oldest", "오래된순"], ["random", "랜덤"]]),
            sel("kind", "검색 종류 (검색어가 있을 때)", [["title", "제목"], ["artist", "작가"], ["character", "캐릭터"], ["tag", "태그 (영어, 예: full_color)"], ["all", "전체"]]),
        ];
    }

    getSourcePreferences() {
        return [{
            key: "mangatoki_domain",
            editTextPreference: { title: "사이트 주소", summary: "주소가 바뀌면 https://….mangatokiN.com 형식으로 입력 (비우면 기본 주소)", value: "", dialogTitle: "사이트 주소", dialogMessage: DEFAULT_BASE_URL },
        }];
    }
}
