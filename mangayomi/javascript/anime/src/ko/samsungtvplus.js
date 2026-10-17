const mangayomiSources = [{
    "name": "삼성 TV 플러스",
    "lang": "ko",
    "baseUrl": "https://www.samsungtvplus.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.0",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/samsungtvplus.js"
}];

// Aniyomi SamsungTvPlus.kt(삼성 TV 플러스)를 망가요미용으로 옮긴 소스.
// 삼성이 광고를 넣어 무료로 제공하는 공식 실시간 채널(한국 채널).
// - 채널 목록·편성: i.mjh.nz 가 삼성 공개 정보를 모아 둔 .channels.json 의 regions.kr
//   (안 되면 같은 목록의 m3u 사본 dc-toki-aniyomi-media.pages.dev)
// - 영상: jmp2.uk/stvp-{채널ID} 가 삼성 공식 영상 서버(akamaized·mediatailor) 주소로 넘겨 줌. 복사 방지(DRM) 없음
// 분류(뉴스·예능·드라마 …)마다 카드 하나, 회차 = 채널. 회차 옆에 지금·다음 프로그램을 보여 준다.
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Mobile Safari/537.36";
const THUMB = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs/tv.png";
const STV_JSON = "https://i.mjh.nz/SamsungTVPlus/.channels.json";
const STV_M3U = "https://dc-toki-aniyomi-media.pages.dev/playlist/samsung-tv-plus.m3u";
const STV_STREAM = "https://jmp2.uk/stvp-";
const STV_ALL = "전체";
const STV_CACHE_MS = 30 * 60 * 1000;

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
        const v = new SharedPreferences().get("stv_quality");
        want = LIVE_QUALITY_CHOICES[Number(v)] || (LIVE_QUALITY_CHOICES.includes(v) ? v : "자동");
    } catch (e) {
        want = "자동";
    }
    if (want === "자동") return list;
    return list.filter((x) => x.quality.includes(` ${want}`)).concat(list.filter((x) => !x.quality.includes(` ${want}`)));
}

function qParam(url, key) {
    const m = new RegExp(`[?&]${key}=([^&]*)`).exec(String(url || ""));
    if (!m) return "";
    try {
        return decodeURIComponent(m[1].replace(/\+/g, " "));
    } catch (e) {
        return m[1];
    }
}

function compact(s) {
    return String(s || "").replace(/\s/g, "").toLowerCase();
}

function hhmm(sec) {
    const d = new Date(sec * 1000 + 9 * 3600000).toISOString();
    return d.substring(11, 16);
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
        this._cache = [];
        this._cacheAt = 0;
    }

    getHeaders(url) {
        return { "User-Agent": UA };
    }

    // ---------- 채널 목록 (30분 동안 기억) ----------
    async channels() {
        const now = Date.now();
        if (this._cache.length && now - this._cacheAt < STV_CACHE_MS) return this._cache;
        let list = [];
        try {
            list = await this.fromJson();
        } catch (e) {
            list = [];
        }
        if (!list.length) {
            try {
                list = await this.fromM3u();
            } catch (e) {
                list = [];
            }
        }
        if (!list.length) {
            if (this._cache.length) return this._cache;
            throw new Error("삼성 TV 플러스 채널 목록을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
        }
        list.sort((a, b) => a.chno - b.chno);
        this._cache = list;
        this._cacheAt = now;
        return list;
    }

    // {"regions":{"kr":{"channels":{ID:{name, chno, logo, description, group, programs:[[시작초, 제목]…]}}}}}
    async fromJson() {
        const res = await this.client.get(STV_JSON, { "User-Agent": UA });
        if (res.statusCode !== 200) return [];
        const body = String(res.body || "");
        const data = JSON.parse(body.substring(Math.max(0, body.indexOf("{"))));
        const kr = (((data || {}).regions || {}).kr || {}).channels || {};
        return Object.keys(kr).map((id) => {
            const o = kr[id] || {};
            return {
                id,
                name: String(o.name || id).trim(),
                chno: Number(o.chno) || 9999,
                logo: o.logo || "",
                group: String(o.group || "").trim() || "기타",
                programs: Array.isArray(o.programs) ? o.programs.filter((p) => Array.isArray(p)).map((p) => [Number(p[0]), String(p[1] || "")]) : [],
            };
        });
    }

    // #EXTINF:-1 tvg-id="ID" tvg-logo="…" group-title="뉴스" tvg-chno="501",YTN
    async fromM3u() {
        const res = await this.client.get(STV_M3U, { "User-Agent": UA });
        if (res.statusCode !== 200) return [];
        const out = [];
        for (const line of String(res.body || "").replace(/\r/g, "").split("\n")) {
            if (!line.startsWith("#EXTINF")) continue;
            const attr = (k) => (new RegExp(`${k}="([^"]*)"`).exec(line) || [])[1] || "";
            const id = attr("tvg-id");
            if (!id) continue;
            const name = line.substring(line.indexOf(",", Math.max(0, line.lastIndexOf('"'))) + 1).trim();
            out.push({ id, name: name || id, chno: Number(attr("tvg-chno")) || 9999, logo: attr("tvg-logo"), group: attr("group-title") || "기타", programs: [] });
        }
        return out;
    }

    // ---------- 편성 (지금 · 다음) ----------
    nowNext(ch) {
        const now = Date.now() / 1000;
        const sorted = ch.programs.slice().sort((a, b) => a[0] - b[0]);
        let cur = null;
        let next = null;
        for (const p of sorted) {
            if (p[0] <= now) cur = p[1];
            else if (!next) next = p;
        }
        return { cur, next };
    }

    scheduleLine(ch) {
        const { cur, next } = this.nowNext(ch);
        const parts = [];
        if (cur) parts.push(`지금: ${cur}`);
        if (next) parts.push(`다음 ${hhmm(next[0])} ${next[1]}`);
        return parts.join(" · ");
    }

    // ---------- 카드 (분류 묶음) ----------
    async pick(group, q) {
        const all = await this.channels();
        return all.filter((c) => (group === STV_ALL || c.group === group) &&
            (!q || compact(c.name).includes(compact(q)) || compact(this.nowNext(c).cur).includes(compact(q))));
    }

    async card(group, q) {
        const list = await this.pick(group, q);
        const logo = (list.find((c) => c.logo) || {}).logo || THUMB;
        return {
            name: (q ? `🔎 "${q}"` : (group === STV_ALL ? "📺 전체 채널" : `📺 ${group}`)) + ` · ${list.length}채널`,
            imageUrl: logo,
            link: `/g?g=${encodeURIComponent(group)}` + (q ? `&q=${encodeURIComponent(q)}` : ""),
        };
    }

    async getPopular(page) {
        const all = await this.channels();
        const groups = all.map((c) => c.group).filter((g, i, a) => a.indexOf(g) === i);
        const list = [];
        for (const g of groups.concat([STV_ALL])) list.push(await this.card(g, ""));
        return { list, hasNextPage: false };
    }

    get supportsLatest() {
        return false;
    }

    async getLatestUpdates(page) {
        return this.getPopular(page);
    }

    // 검색: 채널 이름이나 지금 방송 중인 프로그램 이름
    async search(query, page, filters) {
        const q = String(query || "").trim();
        if (!q) return this.getPopular(page);
        return { list: [await this.card(STV_ALL, q)], hasNextPage: false };
    }

    async getDetail(url) {
        const g = qParam(url, "g") || STV_ALL;
        const q = qParam(url, "q");
        const c = await this.card(g, q);
        const list = await this.pick(g, q);
        return {
            name: c.name,
            imageUrl: c.imageUrl,
            link: url,
            description: "삼성 TV 플러스: 삼성이 광고를 넣어 무료로 제공하는 공식 실시간 채널입니다.\n" +
                "회차(채널) 옆에 지금·다음 프로그램이 나옵니다. 편성은 목록을 다시 불러오면 새로 바뀝니다.\n" +
                "한국에서만 나오는 채널이 있을 수 있습니다.",
            status: 0,
            genre: [],
            episodes: list.map((ch) => ({
                name: ch.name,
                url: `/ch?id=${encodeURIComponent(ch.id)}`,
                scanlator: [g === STV_ALL ? ch.group : "", this.scheduleLine(ch)].filter((x) => x).join(" · "),
            })),
        };
    }

    // ---------- 재생: jmp2.uk 가 삼성 공식 영상 주소로 넘겨 줌 ----------
    async getVideoList(url) {
        const id = qParam(url, "id");
        if (!id) throw new Error("잘못된 채널 주소");
        const h = { "User-Agent": UA };
        const res = await this.client.get(STV_STREAM + id, h);
        if (res.statusCode !== 200) {
            throw new Error(`영상 주소를 받지 못했습니다 (HTTP ${res.statusCode}). 한국에서만 나오는 채널이거나 잠시 중단된 채널일 수 있습니다.`);
        }
        // 망가요미는 넘어간 최종 주소를 알려 주지 않으므로, 화질 목록의 절대 주소를 쓰고 자동 화질은 jmp2.uk 주소 그대로
        const variants = liveVariants(STV_STREAM + id, String(res.body || ""));
        const label = "삼성 공식";
        const list = [{ url: STV_STREAM + id, originalUrl: STV_STREAM + id, quality: `${label} 자동`, headers: h }]
            .concat(variants.map((v) => ({ url: v.u, originalUrl: v.u, quality: `${label} ${v.h}p`, headers: h })));
        return liveQualitySort(list);
    }

    getSourcePreferences() {
        return [
            {
                key: "stv_quality",
                listPreference: {
                    title: "선호 화질",
                    summary: "채널이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다.",
                    valueIndex: 0,
                    entries: LIVE_QUALITY_CHOICES,
                    entryValues: LIVE_QUALITY_CHOICES,
                },
            },
        ];
    }
}
