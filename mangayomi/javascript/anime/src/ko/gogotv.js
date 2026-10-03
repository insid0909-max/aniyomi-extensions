const mangayomiSources = [{
    "name": "고고티비",
    "lang": "ko",
    "baseUrl": "https://gogotv2.xyz",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "version": "0.1.2",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/gogotv.js"
}];

// Aniyomi GogoTV.kt(고고티비)를 망가요미용으로 옮긴 소스
const DEFAULT_BASE_URL = "https://gogotv2.xyz";
const DOMAIN_RE = /^https:\/\/gogotv\d+\.xyz$/;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const PLAYER_HINT = /(?:mode\.php|player|embed|\/v\/|\/e\/|[?&]key=)/i;
const MEDIA_RE = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/i;
const SEARCH_PARAMS = ["stx", "q", "keyword", "kwd", "search"];

const CATEGORIES = [
    ["드라마", "list-drama"], ["영화", "list-movie"], ["예능", "list-vraiety"],
    ["TV프로", "list-tvshow"], ["음악프로", "list-music"], ["애니", "list-animation"],
];
const SORTS = [["업데이트순", "1"], ["주간인기순", "2"], ["월간인기순", "3"], ["전체인기순", "4"]];
const COUNTRIES = [
    ["전체", ""], ["한국", "1"], ["미국", "2"], ["중국", "3"], ["홍콩", "4"],
    ["대만", "5"], ["일본", "6"], ["영국", "7"], ["프랑스", "8"],
];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getBaseUrl() {
        let custom = "";
        try {
            custom = (new SharedPreferences().get("gogotv_domain") || "").trim().replace(/\/+$/, "");
        } catch (e) {
            custom = "";
        }
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    headers(referer) {
        return { "User-Agent": UA, "Referer": referer || `${this.getBaseUrl()}/` };
    }

    async getDoc(path) {
        const base = this.getBaseUrl();
        const url = path.startsWith("http") ? path : base + path;
        const res = await this.client.get(url, this.headers());
        return { doc: new Document(res.body), base: base };
    }

    listPath(cat, sort, country, page) {
        const params = [];
        if (country) params.push(`country=${country}`);
        if (sort) params.push(`o=${sort}`);
        if (page > 1) params.push(`page=${page}`);
        return `/${cat}${params.length ? "?" + params.join("&") : ""}`;
    }

    // ================= 목록 =================
    async getPopular(page) {
        return this.parseList(await this.getDoc(this.listPath("list-drama", "2", "", page)));
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.parseList(await this.getDoc(this.listPath("list-drama", "1", "", page)));
    }

    async search(query, page, filters) {
        if (query && query.trim()) {
            const q = encodeURIComponent(query.trim());
            const pageParam = page > 1 ? `&page=${page}` : "";
            // 검색 주소의 파라미터 이름을 몰라서 후보를 차례로 시도
            let result = { list: [], hasNextPage: false };
            for (const param of SEARCH_PARAMS) {
                result = this.parseList(await this.getDoc(`/search/?${param}=${q}${pageParam}`));
                if (result.list.length > 0) break;
            }
            return result;
        }
        const pick = (i, list) => {
            const f = filters && filters[i];
            return list[(f && f.state) || 0][1];
        };
        return this.parseList(await this.getDoc(
            this.listPath(pick(0, CATEGORIES), pick(1, SORTS), pick(2, COUNTRIES), page)));
    }

    parseList({ doc, base }) {
        const seen = {};
        const list = [];
        for (const dl of doc.select(".itemLish-cont dl, .modList-ul dl, .view-floor3 .item dl")) {
            const a = dl.selectFirst("a[href*='/player/']");
            if (!a) continue;
            const link = this.toPath(a.attr("href"));
            if (!link || seen[link]) continue;
            const img = dl.selectFirst("img");
            const titleNode = dl.selectFirst(".tit");
            const name = ((titleNode && titleNode.text) || (img && img.attr("alt")) || "").trim();
            if (!name) continue;
            seen[link] = true;
            list.push({ name: name, imageUrl: img ? this.resolveUrl(`${base}/`, img.attr("src")) : "", link: link });
        }
        return { list: list, hasNextPage: this.hasNextPage(doc) };
    }

    hasNextPage(doc) {
        const cur = doc.selectFirst(".paging a.on");
        const curNum = cur ? parseInt(cur.text.trim(), 10) : NaN;
        if (isNaN(curNum)) return false;
        let max = 0;
        for (const a of doc.select(".paging a[href]")) {
            const m = /[?&]page=(\d+)/.exec(a.attr("href"));
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return max > curNum;
    }

    // ================= 상세 / 회차 =================
    async getDetail(url) {
        const { doc, base } = await this.getDoc(url);
        const titleNode = doc.selectFirst(".view-floor2-lf-cont .tit") || doc.selectFirst(".view-floor2-tit");
        const poster = doc.selectFirst(".view-floor2-lf-img img");
        const plotNode = doc.selectFirst(".view-floor2-lf-cont .cont");
        const info = doc.select(".view-floor2-lf-cont .list .right").map((e) => e.text.trim())
            .filter((t) => t && !t.includes(","));
        const cast = doc.select(".view-floor2-lf-cont .list .blue a").map((e) => e.text.trim()).join(", ");

        const links = [];
        const seen = {};
        for (const li of doc.select(".view-floor1-rt-cont li")) {
            const a = li.selectFirst("p.left a[href]") || li.selectFirst("a[href]");
            if (!a) continue;
            const href = this.resolveUrl(`${base}/`, a.attr("href"));
            if (!href || seen[href]) continue;
            seen[href] = true;
            links.push({ name: a.text.trim() || "바로보기", url: href });
        }

        return {
            name: titleNode ? titleNode.text.trim() : "",
            imageUrl: poster ? this.resolveUrl(`${base}/`, poster.attr("src")) : "",
            description: info.concat(plotNode ? [plotNode.text.trim()] : []).filter((t) => t).join("\n\n"),
            author: cast,
            genre: [],
            status: 5,
            link: url,
            episodes: links,
        };
    }

    // ================= 재생 =================
    // 회차 링크(외부 영상 사이트)에서 시작해 새로고침 태그·스크립트 이동·iframe을 따라가며
    // 각 페이지 글자 안에서 영상 주소를 찾는다 (망가요미에는 숨은 브라우저가 없음)
    async getVideoList(url) {
        const base = this.getBaseUrl();
        const trail = [];
        const found = await this.crawl(url, `${base}/`, 0, {}, trail);
        if (!found) {
            throw new Error(`영상 주소를 찾지 못했습니다. 지나간 페이지: ${trail.join(" → ") || url}`);
        }

        const origin = (/^(https?:\/\/[^/]+)/.exec(found.referer) || [null, ""])[1];
        const headers = { "User-Agent": UA, "Referer": found.referer };
        if (origin) headers["Origin"] = origin;
        const quality = found.url.includes(".m3u8") ? "고고티비 (HLS)" : "고고티비";
        return [{ url: found.url, originalUrl: found.url, quality: quality, headers: headers }];
    }

    async crawl(url, referer, depth, visited, trail) {
        if (depth > 3 || visited[url] || Object.keys(visited).length >= 12) return null;
        visited[url] = true;

        let body;
        try {
            const res = await this.client.get(url, this.headers(referer));
            body = String(res.body || "");
            trail.push(`${this.shortUrl(url)}(${res.statusCode})`);
        } catch (e) {
            trail.push(`${this.shortUrl(url)}(오류)`);
            return null;
        }

        const media = this.findMedia(body);
        if (media) return { url: media, referer: url };

        for (const next of this.nextTargets(body, url)) {
            const found = await this.crawl(next, url, depth + 1, visited, trail);
            if (found) return found;
        }
        return null;
    }

    // 다음에 열어 볼 주소: 새로고침 태그, 스크립트 이동, iframe(src·data-src)
    nextTargets(body, pageUrl) {
        const out = [];
        const add = (u) => {
            if (/^(about|javascript|data):/i.test((u || "").trim())) return;
            const abs = this.resolveUrl(pageUrl, (u || "").replace(/&amp;/g, "&"));
            if (/^https?:\/\//.test(abs) && !out.includes(abs)) out.push(abs);
        };
        const text = body.replace(/\\\//g, "/");
        let m;
        const meta = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/gi;
        while ((m = meta.exec(text)) !== null) add(m[1]);
        const js = /(?:location\.href|location\.replace|location\.assign|window\.location|document\.location|top\.location)\s*(?:=|\()\s*["']([^"']+)["']/gi;
        while ((m = js.exec(text)) !== null) add(m[1]);
        // 지연 로딩(data-src)을 먼저 보고, 자리표시(about:blank 등)는 건너뜀
        const tags = text.match(/<iframe\b[^>]*>/gi) || [];
        for (const tag of tags) {
            const lazy = /\sdata-src=["']([^"']+)["']/i.exec(tag);
            const src = /\ssrc=["']([^"']+)["']/i.exec(tag);
            for (const cand of [lazy, src]) {
                if (cand && !/^(about|javascript|data):/i.test(cand[1])) add(cand[1]);
            }
        }
        // window.open, 링크, 폼 이동
        const open = /window\.open\(\s*["']([^"']+)["']/gi;
        while ((m = open.exec(text)) !== null) add(m[1]);
        const forms = /<form\b[^>]*action=["']([^"']+)["']/gi;
        while ((m = forms.exec(text)) !== null) add(m[1]);
        // 그래도 없으면 글자 안의 다른 사이트 플레이어 주소(mode.php, player, embed 등)를 후보로
        if (out.length === 0) {
            const host = (/^https?:\/\/([^/?#]+)/.exec(pageUrl) || [null, ""])[1];
            const cands = text.match(/https?:\/\/[^"'\s<>()]+/g) || [];
            const ranked = cands
                .map((u) => u.replace(/&amp;/g, "&"))
                .filter((u) => !/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)(?:[?#]|$)/i.test(u))
                .filter((u) => !/(?:googletagmanager|google-analytics|jsdelivr|cloudflare|jquery|fonts\.)/i.test(u))
                .filter((u) => !u.includes(`//${host}/`) || /[?&](?:key|v|id|url)=/i.test(u))
                .sort((a, b) => (PLAYER_HINT.test(b) ? 1 : 0) - (PLAYER_HINT.test(a) ? 1 : 0));
            for (const u of ranked) add(u);
        }
        return out.slice(0, 8);
    }

    shortUrl(u) {
        const m = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(u || "");
        return m ? (m[1] + m[2]).substring(0, 50) : String(u).substring(0, 50);
    }

    findMedia(html) {
        if (!html) return null;
        const text = html.replace(/\\\//g, "/");
        let m = MEDIA_RE.exec(text);
        if (m) return m[0];
        // base64로 숨긴 주소 (aHR0c... = "http")
        for (const b64 of text.match(/aHR0c[A-Za-z0-9+/_-]{10,}={0,2}/g) || []) {
            m = MEDIA_RE.exec(this.base64Decode(b64));
            if (m) return m[0];
        }
        // eval(function(p,a,c,k,e,d) ...) 로 압축된 스크립트 풀기
        const packed = text.match(/eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\)\)\)?/g) || [];
        for (const p of packed) {
            try {
                m = MEDIA_RE.exec(unpackJs(p).replace(/\\\//g, "/"));
                if (m) return m[0];
            } catch (e) {
                // 다음 스크립트
            }
        }
        return null;
    }

    // atob가 없는 환경을 위한 base64(일반·URL용) → 글자 변환
    base64Decode(s) {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const clean = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
        let bits = 0;
        let value = 0;
        let out = "";
        for (const ch of clean) {
            const idx = abc.indexOf(ch);
            if (idx < 0) continue;
            value = (value << 6) | idx;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((value >> bits) & 0xff);
            }
        }
        try {
            return decodeURIComponent(escape(out));
        } catch (e) {
            return out;
        }
    }

    // ================= 필터 / 설정 =================
    getFilterList() {
        const select = (name, items) => ({
            type_name: "SelectFilter",
            name: name,
            state: 0,
            values: items.map(([label, value]) => ({ type_name: "SelectOption", name: label, value: value })),
        });
        // 검색어가 없을 때만 적용 (search()에서 0, 1, 2번 순서로 읽음)
        return [
            select("분류", CATEGORIES),
            select("정렬", SORTS),
            select("지역", COUNTRIES),
        ];
    }

    getSourcePreferences() {
        return [{
            key: "gogotv_domain",
            editTextPreference: {
                title: "고고티비 주소 직접 지정 (선택)",
                summary: "비워 두면 기본 주소(https://gogotv2.xyz)를 사용합니다. 주소가 바뀌면 여기에 새 주소를 넣으세요.",
                value: "",
                dialogTitle: "고고티비 주소",
                dialogMessage: "gogotv숫자.xyz 형식의 HTTPS 주소만 사용됩니다.",
            },
        }];
    }

    // ================= 유틸 =================
    toPath(href) {
        if (!href) return "";
        const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(href.trim());
        if (m) return m[1] || "/";
        return href.startsWith("/") ? href.trim() : `/${href.trim()}`;
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
}
