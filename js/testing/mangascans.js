const mangayomiSources = [{
    "id": 1543279656,
    "name": "[시험] Manga-Scans",
    "lang": "en",
    "baseUrl": "https://manga-scans.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/icon/eu.kanade.tachiyomi.extension.ko.newxtoon.png",
    "typeSource": "single",
    "itemType": 0,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.0.1",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "mangascans.js"
}];

// [시험] Manga-Scans (manga-scans.com, 영어 번역 만화·웹툰, 2026-11-24 사용자 "테스트 버전 만들기").
// 워드프레스 화면 글을 그대로 읽음 (보안 확인 없음, 그림 서버 cdn.black-clover.org 도 머리글 없이 열림)
// 목록: /updates/page/N/ (최신 회차 60개씩) · /newest/page/N/ (새 작품 60개씩) · /comic-type/{manhwa|manhua|manga}/page/N/ ·
//       /manga-status/{ongoing|completed}/page/N/ (120개씩) · 검색 /page/N/?s=검색어
// 카드: .Latest_chapter_update 의 thead a[href*=/manga/][title] + img
// 작품: /manga/{slug}/ — h1.entry-title, img.wp-post-image, td.manga-description p, 정보 표(Alternative·Author·Genres·Type·Realized in·Status),
//       회차 ul.chapterslist li a.title("CHAPTER 254" + NEW 표시) + span.entry-date("18 hours ago")
// 회차: /chapter/{slug}-chapter-N/ — .entry-content img (src)
const SITE = "https://manga-scans.com";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const LISTS = [
    ["최신 회차 (Latest Updates)", "updates"],
    ["새 작품 (Newest)", "newest"],
    ["종류: Manhwa (한국)", "comic-type/manhwa"],
    ["종류: Manhua (중국)", "comic-type/manhua"],
    ["종류: Manga (일본)", "comic-type/manga"],
    ["상태: 연재 중", "manga-status/ongoing"],
    ["상태: 완결", "manga-status/completed"],
];
const F_LIST = "목록 (검색어가 없을 때)";

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${SITE}/` };
    }

    get supportsLatest() {
        return true;
    }

    /** 화면 받기 (실패하면 오류 끝에 [단계 · HTTP · 주소 모양]) */
    async page(url, stage) {
        let res = null;
        let err = "";
        for (let i = 0; i < 2 && !res; i++) {
            try {
                res = await this.client.get(url, this.getHeaders(url));
            } catch (e) {
                err = String((e && e.message) || e).substring(0, 60);
                if (i === 0) await new Promise((ok) => setTimeout(ok, 700));
            }
        }
        const shape = String(url).replace(/^https?:\/\//, "").split("?")[0].substring(0, 60);
        if (!res) throw new Error(`사이트에 연결하지 못했어요 [${stage} · ${err} · ${shape}]`);
        if (res.statusCode !== 200) throw new Error(`사이트가 응답하지 않아요 [${stage} · HTTP ${res.statusCode} · ${shape}]`);
        return String(res.body || "");
    }

    abs(u) {
        u = String(u || "").trim();
        if (!u) return "";
        if (u.startsWith("//")) return "https:" + u;
        if (u.startsWith("/")) return SITE + u;
        return u;
    }

    /** 목록 화면 → 카드 (같은 작품은 한 번만) */
    cards(html, page) {
        const doc = new Document(html);
        const list = [];
        const seen = {};
        for (const box of doc.select(".Latest_chapter_update")) {
            const as = box.select("a[href*='/manga/']");
            if (!as.length) continue;
            const link = this.abs(as[0].attr("href"));
            if (!/\/manga\/[^/]+\/?$/.test(link) || seen[link]) continue;
            seen[link] = true;
            let name = as[0].attr("title") || "";
            if (!name) {
                const h = box.select("h4 a");
                name = h.length ? h[0].text.trim() : "";
            }
            const imgs = box.select("img");
            const img = imgs.length ? (imgs[0].attr("data-src") || imgs[0].attr("src")) : "";
            list.push({ name: name.trim() || link.split("/").filter((x) => x).pop(), imageUrl: this.abs(img), link });
        }
        // 다음 쪽: 쪽 번호 링크(…/page/N+1/) 또는 꽉 찬 쪽
        const next = new RegExp(`/page/${page + 1}/`).test(html);
        return { list, hasNextPage: list.length > 0 && next };
    }

    async listing(path, page) {
        const url = page > 1 ? `${SITE}/${path}/page/${page}/` : `${SITE}/${path}/`;
        return this.cards(await this.page(url, "목록"), page);
    }

    async getPopular(page) {
        return this.listing("newest", page);
    }

    async getLatestUpdates(page) {
        return this.listing("updates", page);
    }

    async search(query, page, filters) {
        const q = String(query || "").trim();
        // 작품 주소를 붙여 넣으면 그 작품 하나
        const m = /manga-scans\.com\/manga\/([^/?#\s]+)/i.exec(q);
        if (m) {
            const link = `${SITE}/manga/${m[1]}/`;
            const d = await this.getDetail(link);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link }], hasNextPage: false };
        }
        if (q) {
            const url = page > 1 ? `${SITE}/page/${page}/?s=${encodeURIComponent(q)}` : `${SITE}/?s=${encodeURIComponent(q)}`;
            return this.cards(await this.page(url, "검색"), page);
        }
        const f = (filters || []).find((x) => x && x.name === F_LIST);
        const idx = f ? Number(f.state) || 0 : 0;
        return this.listing((LISTS[idx] || LISTS[0])[1], page);
    }

    /** "18 hours ago" · "1 week ago" → 시각(ms) */
    ago(text) {
        const t = String(text || "").toLowerCase().trim();
        const m = /(\d+|an?|one)\s*(second|min|minute|hour|day|week|month|year)s?\s*ago/.exec(t);
        if (m) {
            const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
            const unit = { second: 1e3, min: 6e4, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2]];
            return Date.now() - n * unit;
        }
        const d = Date.parse(t);
        return isNaN(d) ? null : d;
    }

    async getDetail(url) {
        const link = this.abs(url);
        const html = await this.page(link, "작품");
        const doc = new Document(html);
        const h1 = doc.select("h1.entry-title");
        const name = h1.length ? h1[0].text.trim() : "";
        const covers = doc.select(".manga-cover img, img.wp-post-image");
        const imageUrl = covers.length ? this.abs(covers[0].attr("data-src") || covers[0].attr("src")) : "";

        // 줄거리 (광고 칸 빼고 글만)
        const desc = doc.select("td.manga-description p").map((p) => p.text.trim()).filter((t) => t);

        // 정보 표: 칸 이름 → 값
        const info = {};
        for (const tr of doc.select("table.infobox tr")) {
            const tds = tr.select("td");
            if (tds.length < 2) continue;
            const key = tds[0].text.trim().toLowerCase();
            const vals = tds[1].select("a").map((a) => a.text.trim()).filter((t) => t);
            info[key] = vals.length ? vals : [tds[1].text.trim()].filter((t) => t);
        }
        const st = String((info.status || [])[0] || "").toLowerCase();
        const status = st.includes("ongoing") ? 0 : st.includes("complet") ? 1 : st.includes("hiatus") ? 2 : 5;
        const genre = [].concat(info.type || [], info.genres || []);
        const head = [];
        if ((info.alternative || []).length) head.push(`다른 이름: ${info.alternative.join(", ")}`);
        if ((info["realized in"] || []).length) head.push(`연도: ${info["realized in"].join(", ")}`);

        const chapters = [];
        const seen = {};
        for (const li of doc.select("ul.chapterslist li")) {
            const as = li.select("a");
            if (!as.length) continue;
            const href = this.abs(as[0].attr("href"));
            if (!href || seen[href]) continue;
            seen[href] = true;
            // "CHAPTER 254 NEW" → "Chapter 254"
            const raw = as[0].text.replace(/\bNEW\b/g, "").replace(/\s+/g, " ").trim();
            let nm = raw.replace(/^chapter\b/i, "Chapter") || href.split("/").filter((x) => x).pop();
            // 0화는 망가요미가 번호로 못 써서(겹침 막기가 모든 회차 앞에 번호를 붙임) 0.5 로
            if (/^Chapter 0$/i.test(nm)) nm = "Chapter 0.5 (원래 0화)";
            const ds = li.select(".entry-date");
            const at = ds.length ? this.ago(ds[0].text) : null;
            // 같은 회차가 두 번 올라온 경우(dandadan-chapter-165 와 -165-2) 하나만 — 주소가 짧은(원래) 쪽
            const dup = chapters.findIndex((c) => c.name === nm);
            if (dup >= 0) {
                if (href.length < chapters[dup].url.length) chapters[dup].url = href;
                continue;
            }
            chapters.push({ name: nm, url: href, dateUpload: at ? String(at) : null });
        }
        if (!chapters.length && !name) throw new Error(`작품 화면을 읽지 못했어요 [작품 · 회차 0 · ${link.replace(/^https?:\/\//, "").substring(0, 60)}]`);

        return {
            name,
            imageUrl,
            description: head.concat(desc).join("\n\n"),
            author: (info.author || []).join(", "),
            artist: "",
            genre,
            status,
            link,
            chapters,
        };
    }

    async getPageList(url) {
        const link = this.abs(url);
        const html = await this.page(link, "회차");
        const doc = new Document(html);
        const pages = [];
        for (const img of doc.select(".entry-content img")) {
            const src = this.abs(img.attr("data-src") || img.attr("data-lazy-src") || img.attr("src"));
            if (!/^https?:\/\//.test(src) || /\.gif(?:$|\?)|\/wp-content\/uploads\/20\d\d\/\d\d\/MANGA-SCANS/i.test(src)) continue;
            if (pages.some((p) => p.url === src)) continue;
            pages.push({ url: src, headers: this.getHeaders(src) });
        }
        if (!pages.length) throw new Error(`그림을 찾지 못했어요 [회차 · 그림 0 · ${link.replace(/^https?:\/\//, "").substring(0, 60)}]`);
        return pages;
    }

    getFilterList() {
        return [
            { type_name: "HeaderFilter", name: `📝 [시험] ${mangayomiSources[0].version} · 영어 번역 사이트 · 작품 주소를 붙여 넣으면 바로 열기` },
            {
                type_name: "SelectFilter", name: F_LIST, state: 0,
                values: LISTS.map((x, i) => ({ type_name: "SelectOption", name: x[0], value: String(i) })),
            },
        ];
    }

    getSourcePreferences() {
        return [];
    }
}

// ---------- 필터 맨 끝 빈 줄 (2026-11-03, 웹툰 확장들과 같음) ----------
(function () {
    const base = DefaultExtension.prototype.getFilterList;
    DefaultExtension.prototype.getFilterList = function () {
        const list = base.apply(this, arguments) || [];
        return list.concat([1, 2, 3].map(() => ({ type_name: "HeaderFilter", name: "　" })));
    };
})();

// ---------- 회차 번호 겹침 막기 (2026-11-07 회차 점검, 웹툰 확장들과 같은 코드) ----------
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
    const guessNo = (title, name) => {
        const core = String(name || "").replace(/\s*·\s*(?:남은\s*\d+\s*화|마지막)\s*$/, "").replace(/\s*\(\d{2}(?:\.\d{2}){1,2}\)\s*$/, "");
        const m = /(\d+(?:[.-]\d+)?)\s*(?:화|회|話)/.exec(core) || /chapter\s*(\d+(?:[.-]\d+)?)/i.exec(core);
        if (m) return parseFloat(m[1].replace("-", "."));
        return read(title, core).ep;
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const list = d && (d.episodes || d.chapters);
        if (!list || !list.length) return d;
        const title = String(d.name || "");
        if (ok(list, title) && ok(list, "")) return d;
        let last = 0;
        const fmt = (v) => String(Math.round(v * 100) / 100);
        for (let i = list.length - 1; i >= 0; i--) {
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

// ---------- 검색 띄어쓰기 (2026-11-05, 웹툰 확장들과 같은 코드) ----------
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
        const plain = q.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/[㐀-鿿]+/g, " ").replace(/\s+/g, " ").trim();
        const words = plain.split(" ").filter((w) => w);
        add(plain);
        if (words.length > 2) add(words.slice(0, words.length - 1).join(" "));
        if (words.length > 1) add(words.slice(0, Math.ceil(words.length / 2)).join(" "));
        add(joined);
        if (joined.length > 2) add(joined.substring(0, Math.max(2, Math.ceil(joined.length / 2))));
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
