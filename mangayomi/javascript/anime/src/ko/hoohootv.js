const mangayomiSources = [{
    "name": "후후티비",
    "lang": "ko",
    "baseUrl": "https://fo.hoohootv459.xyz",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": true,
    "version": "0.1.0",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/hoohootv.js"
}];

// Aniyomi HoohooTV.kt(후후티비)를 망가요미용으로 옮긴 소스.
// 목록: /tv/분류, /movie/분류 (?page=N), 작품: /detail/ID/ (회차는 ?season=S&episode=E),
// 회차 목록은 작품 페이지의 episodes-data(JSON), 영상은 플레이어(iframe) 페이지 글자 안에서 찾는다.
const DEFAULT_BASE_URL = "https://fo.hoohootv459.xyz";
const DOMAIN_RE = /^https:\/\/(?:[a-z0-9-]+\.)*hoohootv\d*\.[a-z]{2,6}$/;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const MEDIA_RE = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/i;
const SEARCH_PARAMS = ["q", "query", "keyword", "search", "s"];

const CATEGORIES = [
    ["TV 전체", "/tv/all"], ["드라마", "/tv/%EB%93%9C%EB%9D%BC%EB%A7%88"], ["예능", "/tv/Reality"],
    ["토크쇼", "/tv/Talk"], ["TV 코미디", "/tv/%EC%BD%94%EB%AF%B8%EB%94%94"],
    ["TV 애니메이션", "/tv/%EC%95%A0%EB%8B%88%EB%A9%94%EC%9D%B4%EC%85%98"],
    ["TV 다큐멘터리", "/tv/%EB%8B%A4%ED%81%90%EB%A9%98%ED%84%B0%EB%A6%AC"], ["키즈", "/tv/Kids"],
    ["영화 전체", "/movie/all"], ["영화 - 액션", "/movie/%EC%95%A1%EC%85%98"],
    ["영화 - 코미디", "/movie/%EC%BD%94%EB%AF%B8%EB%94%94"], ["영화 - 스릴러", "/movie/%EC%8A%A4%EB%A6%B4%EB%9F%AC"],
    ["영화 - 로맨스", "/movie/%EB%A1%9C%EB%A7%A8%EC%8A%A4"], ["영화 - 공포", "/movie/%EA%B3%B5%ED%8F%AC"],
    ["영화 - 범죄", "/movie/%EB%B2%94%EC%A3%84"], ["영화 - 애니메이션", "/movie/%EC%95%A0%EB%8B%88%EB%A9%94%EC%9D%B4%EC%85%98"],
    ["영화 - 다큐멘터리", "/movie/%EB%8B%A4%ED%81%90%EB%A9%98%ED%84%B0%EB%A6%AC"],
];

// ---------- 접속 속도 제한 · 화질 나누기 ----------
let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 350 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// 이 헤더로 영상 주소가 실제로 열리는지 (m3u8 이면 내용까지 확인)
async function mediaWorks(client, url, headers) {
    try {
        const res = await client.get(url, headers);
        if (Number(res.statusCode) >= 400) return false;
        return !url.includes(".m3u8") || String(res.body || "").trim().startsWith("#EXTM3U");
    } catch (e) {
        return false;
    }
}

async function hlsExpand(client, url, label, headers) {
    const one = [{ url, originalUrl: url, quality: label, headers }];
    if (!url.includes(".m3u8")) return one;
    let body = "";
    try {
        const res = await client.get(url, headers);
        if (Number(res.statusCode) >= 400) return one;
        body = String(res.body || "").replace(/\r/g, "");
    } catch (e) {
        return one;
    }
    const seen = {};
    const variants = [];
    const re = /#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)/g;
    let m;
    while ((m = re.exec(body))) {
        const h = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
        if (!h || seen[h[1]]) continue;
        seen[h[1]] = true;
        let u = m[2].trim();
        if (!/^https?:\/\//.test(u)) {
            u = u.startsWith("/") ? (/^(https?:\/\/[^/]+)/.exec(url) || [null, ""])[1] + u : url.replace(/[^/]*(?:\?.*)?$/, "") + u;
        }
        variants.push({ h: Number(h[1]), u });
    }
    if (variants.length < 2) return one;
    variants.sort((a, b) => b.h - a.h);
    return [{ url, originalUrl: url, quality: `${label} 자동`, headers }]
        .concat(variants.map((v) => ({ url: v.u, originalUrl: v.u, quality: `${label} ${v.h}p`, headers })));
}

// 설정의 선호 화질을 맨 앞으로
function qualitySort(prefKey, list) {
    let want = "자동";
    try {
        const v = new SharedPreferences().get(prefKey);
        want = QUALITY_CHOICES[Number(v)] || (QUALITY_CHOICES.includes(v) ? v : "자동");
    } catch (e) {
        want = "자동";
    }
    return list.filter((x) => x.quality.endsWith(` ${want}`)).concat(list.filter((x) => !x.quality.endsWith(` ${want}`)));
}

function qualityPreference(key) {
    return {
        key,
        listPreference: {
            title: "선호 화질",
            summary: "영상이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다.",
            valueIndex: 0,
            entries: QUALITY_CHOICES,
            entryValues: QUALITY_CHOICES,
        },
    };
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    getBaseUrl() {
        let custom = "";
        let auto = "";
        try {
            const p = new SharedPreferences();
            custom = (p.get("hhtv_domain") || "").trim().replace(/\/+$/, "");
            auto = (p.getString("hhtv_auto_domain", "") || "").trim();
        } catch (e) {
            custom = "";
        }
        if (DOMAIN_RE.test(custom)) return custom;
        return DOMAIN_RE.test(auto) ? auto : DEFAULT_BASE_URL;
    }

    headers(referer) {
        return { "User-Agent": UA, "Referer": referer || `${this.getBaseUrl()}/` };
    }

    async getHtml(path) {
        const base = this.getBaseUrl();
        const url = path.startsWith("http") ? path : base + path;
        let res = null;
        // 연결 끊김·시간 초과면 잠깐 쉬고 한 번 더
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, this.headers());
            } catch (e) {
                if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
            }
        }
        if (!res) throw new Error(`접속 실패: ${url}`);
        if (Number(res.statusCode) === 403 || Number(res.statusCode) === 503) {
            throw new Error("사이트 보안 확인이 필요합니다. 오른쪽 위 지구본(WebView) 버튼으로 한 번 열었다 닫은 뒤 다시 불러오세요.");
        }
        return String(res.body || "");
    }

    // 목록·검색·홈 공통: 작품 링크(/detail/)가 있는 카드
    parseList(html) {
        const doc = new Document(html);
        const base = this.getBaseUrl();
        const seen = {};
        const list = [];
        for (const li of doc.select("li")) {
            const as = li.select("a.thumb[href*='/detail/']");
            if (!as.length) continue;
            const m = /\/detail\/([A-Za-z0-9_-]+)/.exec(as[0].attr("href"));
            if (!m) continue;
            const link = `/detail/${m[1]}/`;
            if (seen[link]) continue;
            seen[link] = true;
            const subj = li.select(".subject a");
            const imgs = as[0].select("img");
            const name = (subj.length ? subj[0].text.trim() : "") || (imgs.length ? imgs[0].attr("alt").trim() : "");
            if (!name) continue;
            let img = imgs.length ? imgs[0].attr("data-src") || imgs[0].attr("src") : "";
            if (img && img.startsWith("/")) img = base + img;
            list.push({ name, imageUrl: img, link });
        }
        const cur = Number((/class="current-page">\s*(\d+)/.exec(html) || [null, "0"])[1]);
        let maxPage = 0;
        const re = /[?&]page=(\d+)/g;
        let pm;
        while ((pm = re.exec(html))) maxPage = Math.max(maxPage, Number(pm[1]));
        return { list, hasNextPage: maxPage > cur };
    }

    listPath(path, page) {
        return page > 1 ? `${path}?page=${page}` : path;
    }

    get supportsLatest() {
        return true;
    }

    // 인기 = 사이트 "인기" 메뉴, 최신 = TV 프로그램 전체(최근 올라온 순)
    async getPopular(page) {
        return this.parseList(await this.getHtml(this.listPath("/popular", page)));
    }

    async getLatestUpdates(page) {
        return this.parseList(await this.getHtml(this.listPath("/tv/all", page)));
    }

    async search(query, page, filters) {
        const q = String(query || "").trim();
        const byUrl = /\/detail\/([A-Za-z0-9_-]+)/.exec(q);
        if (byUrl) {
            const link = `/detail/${byUrl[1]}/`;
            const d = await this.getDetail(link);
            return { list: d.name ? [{ name: d.name, imageUrl: d.imageUrl, link }] : [], hasNextPage: false };
        }
        if (q) {
            const pageQ = page > 1 ? `&page=${page}` : "";
            let saved = "";
            try {
                saved = new SharedPreferences().getString("hhtv_search_param", "") || "";
            } catch (e) {
                saved = "";
            }
            if (saved) return this.parseList(await this.getHtml(`/search?${saved}=${encodeURIComponent(q)}${pageQ}`));
            // 검색어 이름을 처음 한 번 찾아 기억
            for (const p of SEARCH_PARAMS) {
                const r = this.parseList(await this.getHtml(`/search?${p}=${encodeURIComponent(q)}${pageQ}`));
                if (r.list.length) {
                    try {
                        new SharedPreferences().setString("hhtv_search_param", p);
                    } catch (e) {
                        // 저장 실패는 무시
                    }
                    return r;
                }
            }
            return { list: [], hasNextPage: false };
        }
        const f = (filters || []).find((x) => x && x.type_name === "SelectFilter");
        const idx = (f && f.state) || 0;
        return this.parseList(await this.getHtml(this.listPath(CATEGORIES[idx][1], page)));
    }

    episodesData(html) {
        const m = /<script[^>]*id="episodes-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
        if (!m) return [];
        try {
            const o = JSON.parse(m[1]);
            const out = [];
            for (const s of Object.keys(o)) {
                for (const e of o[s] || []) {
                    out.push({ season: Number(s) || 1, episode: String(e.episode), label: e.label || `${e.episode}화`, date: e.date || "" });
                }
            }
            return out;
        } catch (e) {
            return [];
        }
    }

    async getDetail(url) {
        const path = (/\/detail\/[A-Za-z0-9_-]+\//.exec(url) || [url])[0];
        const html = await this.getHtml(path);
        const doc = new Document(html);
        const og = (/<meta property="og:title" content="([^"]*)"/.exec(html) || [null, ""])[1];
        const h1 = doc.select(".share-title h1");
        const name = og.replace(/\s*-\s*후후티비\s*$/, "").trim() || (h1.length ? h1[0].text.split(" - ")[0].trim() : "");
        const ov = doc.select(".overview");
        const genre = doc.select(".share-title .datetime-hit a").map((a) => a.text.trim()).filter((t) => t);
        const eps = this.episodesData(html);
        let episodes;
        if (!eps.length) {
            episodes = [{ name: "본편", url: path }];
        } else {
            const multi = new Set(eps.map((e) => e.season)).size > 1;
            eps.sort((a, b) => (a.season - b.season) || (Number(a.episode) - Number(b.episode)));
            episodes = eps.map((e) => {
                const d = /(\d{4})[-.](\d{1,2})[-.](\d{1,2})/.exec(e.date);
                return {
                    name: multi ? `시즌${e.season} ${e.label}` : e.label,
                    url: `${path}?season=${e.season}&episode=${e.episode}`,
                    dateUpload: d ? String(Date.UTC(+d[1], +d[2] - 1, +d[3]) - 9 * 3600000) : null,
                };
            }).reverse();
        }
        return {
            name,
            imageUrl: "",
            description: ov.length ? ov[0].text.trim() : "",
            genre,
            status: eps.length ? 5 : 1,
            link: path,
            episodes,
        };
    }

    async getVideoList(url) {
        const base = this.getBaseUrl();
        const pageUrl = url.startsWith("http") ? url : base + url;
        const html = await this.getHtml(url);
        const f = /<iframe[^>]+(?:data-src|src)="(https?:\/\/[^"]+)"/i.exec(html);
        if (!f) throw new Error("플레이어를 찾지 못했습니다 (로그인이 필요하거나 영상이 없는 회차일 수 있습니다)");
        const player = f[1].replace(/&amp;/g, "&");
        // 플레이어 페이지(와 그 안의 iframe 한 단계)에서 영상 주소를 찾는다
        const tried = [];
        let media = null;
        let referer = pageUrl;
        let target = player;
        for (let depth = 0; depth < 3 && target && !media; depth++) {
            let body = "";
            try {
                const r = await this.client.get(target, this.headers(referer));
                body = String(r.body || "").replace(/\\\//g, "/");
                tried.push(`${target.substring(0, 50)}(${r.statusCode})`);
            } catch (e) {
                tried.push(`${target.substring(0, 50)}(오류)`);
                break;
            }
            const m = MEDIA_RE.exec(body);
            if (m) {
                media = m[0];
                referer = target;
                break;
            }
            const next = /<iframe[^>]+src="(https?:\/\/[^"]+)"/i.exec(body);
            referer = target;
            target = next ? next[1].replace(/&amp;/g, "&") : null;
        }
        if (!media) throw new Error(`영상 주소를 찾지 못했습니다 (망가요미에서는 이 플레이어를 열 수 없을 수 있습니다). 지나간 페이지: ${tried.join(" → ")}`);
        const origin = (/^(https?:\/\/[^/]+)/.exec(referer) || [null, ""])[1];
        const headers = { "User-Agent": UA, "Referer": referer };
        if (origin) headers["Origin"] = origin;
        const q = media.includes(".m3u8") ? "후후티비 (HLS)" : "후후티비";
        return qualitySort("hhtv_quality", await hlsExpand(this.client, media, q, headers));
    }

    getFilterList() {
        return [
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용" },
        ].concat([{
            type_name: "SelectFilter",
            name: "분류",
            state: 0,
            values: CATEGORIES.map(([label, value]) => ({ type_name: "SelectOption", name: label, value })),
        }]);
    }

    getSourcePreferences() {
        return [{
            key: "hhtv_domain",
            editTextPreference: {
                title: "후후티비 주소 직접 지정 (선택)",
                summary: "비워 두면 기본 주소(https://fo.hoohootv459.xyz)를 사용합니다.",
                value: "",
                dialogTitle: "후후티비 주소",
                dialogMessage: "https:// 로 시작하는 후후티비 주소 (예: https://hoohootv1.com)",
            },
        }, qualityPreference("hhtv_quality")];
    }
}

// ---------- 앱 기본 User-Agent 사용 ----------
// 망가요미는 내장 웹뷰에서 Cloudflare 확인을 통과하면 쿠키와 그 웹뷰의 User-Agent 를 함께 저장하고,
// 요청에 User-Agent 가 없을 때만 그 값을 넣는다. 확장이 고정 User-Agent 를 보내면 통과 쿠키가 거부되므로
// 사이트(문서·API) 요청에서는 확장의 User-Agent 를 빼고 앱 값을 쓰게 한다. 영상·이미지 주소 요청은 그대로 둔다.
function appClient(raw) {
    const media = /\.(?:m3u8|mp4|ts|m4s|jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
    const strip = (url, headers) => {
        if (!headers || media.test(String(url || ""))) return headers || {};
        const out = {};
        for (const k in headers) if (k.toLowerCase() !== "user-agent") out[k] = headers[k];
        return out;
    };
    return {
        get: (url, headers) => raw.get(url, strip(url, headers)),
        post: (url, headers, body) => raw.post(url, strip(url, headers), body),
    };
}

