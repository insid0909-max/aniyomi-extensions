const mangayomiSources = [{
    "name": "고고티비",
    "lang": "ko",
    "baseUrl": "https://gogotv2.xyz",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "version": "0.1.0",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/gogotv.js"
}];

// Aniyomi GogoTV.kt(고고티비)를 망가요미용으로 옮긴 소스
const DEFAULT_BASE_URL = "https://gogotv2.xyz";
const DOMAIN_RE = /^https:\/\/gogotv\d+\.xyz$/;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
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
    // 회차 링크(외부 영상 사이트)를 열어 페이지, iframe, 압축된 스크립트 안에서 영상 주소를 찾는다
    async getVideoList(url) {
        const base = this.getBaseUrl();
        const res = await this.client.get(url, this.headers(`${base}/`));
        const pageUrl = (res.request && res.request.url) || url;

        let found = this.findMedia(res.body);
        let referer = pageUrl;
        if (!found) {
            const doc = new Document(res.body);
            for (const frame of doc.select("iframe[src]")) {
                const src = this.resolveUrl(pageUrl, frame.attr("src"));
                if (!/^https?:/.test(src)) continue;
                try {
                    const inner = await this.client.get(src, this.headers(pageUrl));
                    found = this.findMedia(inner.body);
                    if (found) {
                        referer = src;
                        break;
                    }
                } catch (e) {
                    // 다음 iframe
                }
            }
        }
        if (!found) throw new Error(`영상 주소를 찾지 못했습니다: ${pageUrl}`);

        const origin = (/^(https?:\/\/[^/]+)/.exec(referer) || [null, ""])[1];
        const headers = { "User-Agent": UA, "Referer": referer };
        if (origin) headers["Origin"] = origin;
        const quality = found.includes(".m3u8") ? "고고티비 (HLS)" : "고고티비";
        return [{ url: found, originalUrl: found, quality: quality, headers: headers }];
    }

    findMedia(html) {
        if (!html) return null;
        let text = html.replace(/\\\//g, "/");
        let m = MEDIA_RE.exec(text);
        if (m) return m[0];
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
