const mangayomiSources = [{
    "name": "애니24",
    "lang": "ko",
    "baseUrl": "https://www.ohli24.net",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.11",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/ohli24.js"
}];

// Aniyomi Ohli24.kt(애니24)를 망가요미용으로 옮긴 소스.
// 목록: /index.php?s=api&c=api&m=template&format=jsonp&name={ong|list|movie}.html&catid={3|1|2}&order=&weeks=&keyword=&page=
//   (방영중·완결·극장판, 응답은 callback({"msg":"목록 HTML"}))
// 검색: /search/keyword-{검색어}[-parent_id-0-page-N].html, 작품: /{번호}/{제목}.html (회차 .eps-box, 날짜 .eps-date),
// 회차: /{번호}/{제목}-N화.html 안의 iframe#video(michealcdn.com/video/…) 플레이어
const DEFAULT_BASE_URL = "https://www.ohli24.net";
const DOMAIN_RE = /^https:\/\/(?:www\.)?ohli\d*24\.[a-z]{2,6}$/;
const HOST_RE = /^https?:\/\/(?:www\.)?ohli\d*24\.[a-z]{2,6}(?=\/|$)/;
const LABEL = "애니24";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함)
const KINDS = [["방영중", "ong", "3"], ["완결", "list", "1"], ["극장판", "movie", "2"]];
const DAYS = ["전체", "일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "기타"];
const GENRES = [
    "전체", "미스테리", "추리", "거대로봇", "SF", "모험", "백합", "판타지", "이세계", "코미디", "하렘", "학원",
    "로맨스", "액션", "닌자", "아이돌", "게임", "스포츠", "청춘", "능력", "드라마", "성장", "일상", "연애", "배틀",
];
// 사이트 표시 그대로: 업데이트=updatetime, 인기순=air_date, 방영일=hits
const SORTS = [["업데이트", "updatetime"], ["인기순", "air_date"], ["방영일", "hits"]];
const FILTER_DEFS = [
    ["분류", "kind", KINDS.map((k) => k[0])],
    ["요일 (방영중만)", "weeks", DAYS],
    ["장르", "keyword", GENRES],
    ["정렬", "order", SORTS.map((s) => s[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [0, 0, 0, 1];
const DEFAULT_LATEST = [0, 0, 0, 0];

let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 300 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

// selectFirst 는 비어도 값이 있는 것처럼 보이므로 select()[0] 사용
function first(el, css) {
    const l = el ? el.select(css) : [];
    return l && l.length ? l[0] : null;
}

function decodeHtml(s) {
    return String(s || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'");
}

function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch (e) {
        return s;
    }
}

function dayMs(s) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600000 : 0;
}

function mmdd(ms) {
    const d = new Date(ms + 9 * 3600000).toISOString();
    return d.substring(5, 7) + "." + d.substring(8, 10);
}

function fullDate(ms) {
    const d = new Date(ms + 9 * 3600000);
    const w = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
    return d.toISOString().substring(0, 10).replace(/-/g, ".") + ` (${w})`;
}

// 압축된 자바스크립트(eval(function(p,a,c,k,e,d)…)를 원래 글로 풀기 (흔한 공개 압축 방식)
function unpack(src) {
    try {
        const m = /\}\('([\s\S]*)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/.exec(src);
        if (!m) return "";
        let p = m[1].replace(/\\'/g, "'");
        const a = parseInt(m[2], 10);
        let c = parseInt(m[3], 10);
        const k = m[4].split("|");
        const enc = (n) => (n < a ? "" : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
        const dict = {};
        while (c--) dict[enc(c)] = k[c] || enc(c);
        return p.replace(/\b\w+\b/g, (w) => (w in dict ? dict[w] : w));
    } catch (e) {
        return "";
    }
}

function ruleText(i) {
    return [
        KINDS[i[0]][0],
        i[0] === 0 && i[1] > 0 ? DAYS[i[1]] : null,
        i[2] > 0 ? GENRES[i[2]] : null,
        SORTS[i[3]][0],
    ].filter((x) => x).join(" · ");
}

// 이 헤더로 영상 주소가 실제로 열리는지 (m3u8 이면 내용까지 확인)
async function mediaWorks(client, url, headers) {
    // mp4 같은 영상 파일은 확인하려면 파일 전체를 받아야 해서(망가요미는 본문을 끝까지 받음) 확인하지 않음
    if (!url.includes(".m3u8")) return true;
    try {
        const res = await client.get(url, headers);
        if (Number(res.statusCode) >= 400) return false;
        return !url.includes(".m3u8") || String(res.body || "").trim().startsWith("#EXTM3U");
    } catch (e) {
        return false;
    }
}


const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// HLS 마스터 목록에 화질이 여러 개면 각각 따로 고를 수 있게 나눔. 하나뿐이거나 읽지 못하면 그대로
// 주소에 "1080p" 같은 화질이 적혀 있으면 이름 뒤에 붙임 (mp4·단일 화질 영상도 지금 화질을 알 수 있게)
function withRes(label, url) {
    let path = String(url || "").split("?")[0];
    try {
        path = decodeURIComponent(path);
    } catch (e) {
        // 그대로 사용
    }
    const m = /(?:^|[^0-9])(2160|1440|1080|720|576|480|360|240)[pP](?![0-9a-zA-Z])/.exec(path);
    return m && !label.includes(`${m[1]}p`) ? `${label} ${m[1]}p` : label;
}

async function hlsExpand(client, url, label, headers) {
    const one = [{ url, originalUrl: url, quality: withRes(label, url), headers }];
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
    if (variants.length === 1) return [{ url, originalUrl: url, quality: `${label} ${variants[0].h}p`, headers }];
    if (variants.length < 2) return one;
    variants.sort((a, b) => b.h - a.h);
    return [{ url, originalUrl: url, quality: `${label} 자동 (최대 ${variants[0].h}p)`, headers }]
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
    const hit = (x) => x.quality.endsWith(` ${want}`) || x.quality.includes(` ${want} `);
    return list.filter(hit).concat(list.filter((x) => !hit(x)));
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

// ---------- 인기/최신 탭 규칙 (필터 조건을 탭에 저장) ----------
const RULE_CHOICES = [
    "저장하지 않음 (필터 결과만 보기)",
    "현재 조건을 인기 탭에 저장",
    "현재 조건을 최신 탭에 저장",
    "인기 탭을 기본값으로 복원",
    "최신 탭을 기본값으로 복원",
    "두 탭 모두 기본값으로 복원",
];
const RULE_NAME = "인기/최신 탭 규칙";

// 저장 값은 필터 선택 번호를 쉼표로 이은 문자열. 없거나 맞지 않으면 null (= 기본값)
function ruleRead(prefix, popular, sizes) {
    let raw = "";
    try {
        raw = new SharedPreferences().getString(`${prefix}_${popular ? "pop" : "latest"}_rule`, "") || "";
    } catch (e) {
        return null;
    }
    if (!raw) return null;
    const idx = raw.split(",").map((x) => parseInt(x, 10));
    if (idx.length !== sizes.length || idx.some((v, i) => !(v >= 0 && v < sizes[i]))) return null;
    return idx;
}

function ruleApply(prefix, rule, idx) {
    try {
        const p = new SharedPreferences();
        const pop = `${prefix}_pop_rule`;
        const latest = `${prefix}_latest_rule`;
        const v = idx.join(",");
        if (rule === 1) p.setString(pop, v);
        else if (rule === 2) p.setString(latest, v);
        else if (rule === 3) p.setString(pop, "");
        else if (rule === 4) p.setString(latest, "");
        else if (rule === 5) {
            p.setString(pop, "");
            p.setString(latest, "");
        }
    } catch (e) {
        // 저장 실패는 무시 (필터 결과는 그대로 보여 줌)
    }
}

function ruleFilters(prefix, sizes, defaults, text) {
    const pop = ruleRead(prefix, true, sizes);
    const latest = ruleRead(prefix, false, sizes);
    return [
        { type_name: "SeparatorFilter" },
        { type_name: "HeaderFilter", name: `현재 인기: ${pop ? text(pop) : defaults[0] + " (기본)"}` },
        { type_name: "HeaderFilter", name: `현재 최신: ${latest ? text(latest) : defaults[1] + " (기본)"}` },
        {
            type_name: "SelectFilter", name: RULE_NAME, param: "rule", state: 0,
            values: RULE_CHOICES.map((c, i) => ({ type_name: "SelectOption", name: c, value: String(i) })),
        },
    ];
}


// ---------- 앱 기본 User-Agent 사용 ----------
// 망가요미는 내장 웹뷰에서 Cloudflare 확인을 통과하면 쿠키와 그 웹뷰의 User-Agent 를 함께 저장하고,
// 요청에 User-Agent 가 없을 때만 그 값을 넣는다. 확장이 고정 User-Agent 를 보내면 통과 쿠키가 거부되므로
// 사이트(문서·API) 요청에서는 확장의 User-Agent 를 빼고 앱 값을 쓰게 한다. 영상·이미지 주소 요청은 그대로 둔다.
// 망가요미 변형 앱(Mangayomi Glitch 등)은 User-Agent 를 넣어 주지 않아, 빼고 보내면 사이트가 연결을 끊거나 403 을 줌
// → 그런 응답이면 User-Agent 를 넣어 다시 보내고, 그 뒤로는 처음부터 넣음 (원래 망가요미는 첫 요청이 성공해 그대로)
let APP_NO_UA = false;
function appClient(raw) {
    const media = /\.(?:m3u8|mp4|ts|m4s|jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
    const fallbackUa = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    const strip = (url, headers) => {
        if (!headers || media.test(String(url || ""))) return headers || {};
        const out = {};
        for (const k in headers) if (k.toLowerCase() !== "user-agent") out[k] = headers[k];
        return out;
    };
    const withUa = (headers) => {
        const out = Object.assign({}, headers || {});
        if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) out["User-Agent"] = fallbackUa;
        return out;
    };
    const send = async (call, url, headers) => {
        if (APP_NO_UA || media.test(String(url || ""))) return call(url, APP_NO_UA ? withUa(headers) : headers || {});
        let res;
        try {
            res = await call(url, strip(url, headers));
        } catch (e) {
            res = null;
            try {
                const again = await call(url, withUa(headers));
                APP_NO_UA = true;
                return again;
            } catch (e2) {
                throw e;
            }
        }
        if (res && res.statusCode === 403) {
            try {
                const again = await call(url, withUa(headers));
                if (again && again.statusCode && again.statusCode < 400) {
                    APP_NO_UA = true;
                    return again;
                }
            } catch (e) {}
        }
        return res;
    };
    return {
        get: (url, headers) => send((u, h) => raw.get(u, h), url, headers),
        post: (url, headers, body) => send((u, h) => raw.post(u, h, body), url, headers),
    };
}



class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    // ================= 주소 =================
    getBaseUrl() {
        let custom = "";
        try {
            const p = new SharedPreferences();
            custom = (p.get("ohli24_domain") || "").trim().replace(/\/+$/, "");
            if (!DOMAIN_RE.test(custom)) custom = (p.getString("ohli24_auto_domain", "") || "").trim();
        } catch (e) {
            custom = "";
        }
        return DOMAIN_RE.test(custom) ? custom : DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${this.getBaseUrl()}/` };
    }

    async get(path) {
        const base = this.getBaseUrl();
        const url = /^https?:\/\//.test(path) ? path : base + path;
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, this.getHeaders());
            } catch (e) {
                if (attempt === 1) throw new Error(`애니24 접속 실패: ${String((e && e.message) || e).substring(0, 80)}`);
                await new Promise((r) => setTimeout(r, 700));
            }
        }
        if (res.statusCode >= 400) throw new Error(`애니24 접속 실패 (HTTP ${res.statusCode}). 주소가 바뀌었으면 설정에서 새 주소를 넣어 주세요.`);
        return String(res.body || "");
    }

    /** "https://www.ohli24.net/58723/제목.html" → "/58723/제목.html" (작품·회차 주소만) */
    pathOf(href) {
        let p = String(href || "").trim();
        if (/^https?:\/\//.test(p)) {
            if (!HOST_RE.test(p)) return null;
            p = p.replace(HOST_RE, "");
        }
        p = safeDecode(p.split("#")[0]);
        return /^\/\d+\/[^/]+\.html$/.test(p) ? p : null;
    }

    // ================= 목록 =================
    listPath(idx, page) {
        const k = KINDS[idx[0]];
        const q = ["s=api", "c=api", "m=template", "format=jsonp", `name=${k[1]}.html`, `catid=${k[2]}`, `order=${SORTS[idx[3]][1]}`];
        if (idx[0] === 0 && idx[1] > 0) q.push(`weeks=${idx[1]}`);
        if (idx[2] > 0) q.push(`keyword=${encodeURIComponent(GENRES[idx[2]])}`);
        if (page > 1) q.push(`page=${page}`);
        return "/index.php?" + q.join("&");
    }

    /** 목록 HTML 의 작품 카드(div.show-item) */
    parseCards(html, kind) {
        const doc = new Document(html);
        const seen = {};
        const list = [];
        for (const item of doc.select("div.show-item")) {
            const a = first(item, "a.show-item-img-link") || first(item, ".show-item-tile-link a");
            if (!a) continue;
            const path = this.pathOf(a.attr("href"));
            if (!path || seen[path]) continue;
            seen[path] = true;
            const img = first(item, "img");
            let title = (img && img.attr("title")) || "";
            if (!title) {
                const h = first(item, ".show-item-title");
                title = h ? h.text.trim() : "";
            }
            title = decodeHtml(title).trim();
            // "…"로 잘린 제목은 주소의 제목 부분을 씀
            if (!title || /(\.\.\.|…)$/.test(title)) title = path.replace(/^\/\d+\//, "").replace(/\.html$/, "").replace(/-/g, " ").trim() || title;
            const meta = first(item, ".show-item-original-title");
            const year = ((meta ? meta.text : "").match(/(?:19|20)\d{2}/) || [""])[0];
            if ((kind === "1" || kind === "2") && year && !title.includes(`(${year})`)) title = `${title} (${year})`;
            list.push({ name: title, imageUrl: img ? img.attr("src") : "", link: path });
        }
        const hasNextPage = doc.select("li.next a").length > 0;
        return { list, hasNextPage };
    }

    async listPage(idx, page) {
        const body = await this.get(this.listPath(idx, page));
        const s = body.indexOf("{");
        const e = body.lastIndexOf("}");
        let html = "";
        try {
            html = JSON.parse(body.substring(s, e + 1)).msg || "";
        } catch (err) {
            throw new Error("애니24 목록을 읽지 못했습니다");
        }
        return this.parseCards(html, KINDS[idx[0]][2]);
    }

    async getPopular(page) {
        return this.listPage(ruleRead("ohli24", true, RULE_SIZES) || DEFAULT_POPULAR, page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead("ohli24", false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품 주소를 붙여 넣으면 그 작품을 바로 열기
        const pasted = /ohli\d*24\.[a-z]{2,6}(\/\d+\/[^?#\s]+\.html)/.exec(query);
        if (pasted) {
            const path = safeDecode(pasted[1]);
            const d = await this.getDetail(path);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: path }], hasNextPage: false };
        }
        if (query) {
            const enc = encodeURIComponent(query);
            const html = await this.get(page > 1 ? `/search/keyword-${enc}-parent_id-0-page-${page}.html` : `/search/keyword-${enc}.html`);
            return this.parseCards(html, null);
        }
        const idx = [0, 0, 0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), RULE_SIZES[k] - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (rule) ruleApply("ohli24", rule, idx);
        return this.listPage(idx, page);
    }

    // ================= 작품 정보 · 회차 =================
    async getDetail(url) {
        const path = this.pathOf(url) || url;
        const html = await this.get(path);
        const doc = new Document(html);
        const meta = {};
        for (const li of doc.select(".article-box-meta li")) {
            const spans = li.select("span");
            if (!spans.length) continue;
            const k = spans[0].text.trim().replace(/:$/, "");
            meta[k] = spans.slice(1).map((x) => x.text).join("").trim();
        }
        const crumbs = doc.select("ul.breadcrumb li a").map((a) => a.attr("href"));
        const kind = crumbs.some((h) => /\/finished$/.test(h)) ? "완결" : crumbs.some((h) => /\/movie$/.test(h)) ? "극장판"
            : crumbs.some((h) => /\/ing$/.test(h)) ? "방영중" : "";
        const episodes = [];
        const raw = [];
        for (const a of doc.select(".eps-box .eps-item a")) {
            const p = this.pathOf(a.attr("href"));
            if (!p) continue;
            const dateEl = first(a, ".eps-date");
            const dateText = dateEl ? dateEl.text : "";
            const label = a.text.replace(dateText, "").trim();
            raw.push({ p, label, date: dayMs(dateText) });
        }
        // 사이트는 최신 회차가 위
        raw.forEach((e, i) => {
            const name = (e.label || `${raw.length - i}화`) + (e.date ? ` (${mmdd(e.date)})` : "");
            episodes.push({ name, url: e.p, dateUpload: e.date ? String(e.date) : null });
        });
        const latest = Math.max(0, ...raw.map((e) => e.date));
        const year = ((meta["방영일"] || "").match(/(?:19|20)\d{2}/) || [""])[0];
        const h2 = first(doc, "header.top-movies-list-title h2");
        let title = h2 ? h2.text.trim() : "";
        if (kind === "방영중" && latest) title = `${title} · ${mmdd(latest)}`;
        else if (kind && kind !== "방영중" && year && !title.includes(`(${year})`)) title = `${title} (${year})`;
        const img = first(doc, ".article-box-img img");
        const storyM = /movie-coment[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(html);
        const story = storyM ? decodeHtml(storyM[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).split("\n").map((x) => x.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim() : "";
        const info = ["원제", "원작", "감독", "각본", "방영일", "등급", "총화수"].filter((k) => meta[k]).map((k) => `${k}: ${meta[k]}`).join("\n");
        return {
            name: title,
            imageUrl: img ? img.attr("src") : "",
            link: this.getBaseUrl() + path,
            description: [
                kind === "방영중" && latest ? `방영 중 · 최근 방영: ${fullDate(latest)}` : "",
                story,
                [kind, info].filter((x) => x).join("\n"),
            ].filter((x) => x).join("\n\n"),
            author: meta["원작"] || "",
            status: kind === "방영중" ? 0 : kind ? 1 : 5,
            genre: (meta["장르"] || "").split(/[,/·]/).map((x) => x.trim()).filter((x) => x),
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        const path = this.pathOf(url) || url;
        const pageUrl = this.getBaseUrl() + path;
        const html = await this.get(path);
        const doc = new Document(html);
        const players = [...new Set(doc.select("iframe#video, .play-box iframe").map((f) => f.attr("src")).filter((s) => /^https?:\/\//.test(s)))];
        if (!players.length) throw new Error("이 회차에는 재생 화면이 없습니다");
        let list = [];
        const fails = [];
        this.diag = [];
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            const label = i === 0 ? LABEL : `${LABEL} (대체 ${i})`;
            const origin = (/^(https?:\/\/[^/]+)/.exec(player) || [null, ""])[1];
            // 1) DC 애니24(망가요미판)와 똑같은 방법 (망가요미에서 재생 확인된 방법)
            const dc = await this.dcVideos(player, origin, label);
            if (dc.length) {
                list = list.concat(dc);
                continue;
            }
            // 2) 안 되면 기존 방법: 플레이어 POST → 플레이어 화면 → 웹뷰
            const fire = (await this.firePlayer(player, pageUrl)) || (await this.playerPage(player, pageUrl));
            let found = fire ? fire.url : null;
            if (!fire || !fire.sure) {
                const w = await this.viaWebview(player, pageUrl);
                if (w) found = w;
            }
            if (!found) {
                fails.push((/^https?:\/\/([^/]+)/.exec(player) || [null, player])[1]);
                continue;
            }
            // DC 애니24(망가요미판)와 같은 영상 요청 정보
            const h = { "User-Agent": UA, "Referer": `${origin}/`, "Origin": origin };
            // DC 방법이 실패해서 예비 방법으로 찾은 영상은 이름에 표시 (실패 이유는 이름 끝 [ ])
            const got = (await this.expand(found, label, h)).map((g) => Object.assign(g, { quality: `${g.quality} (예비) [${this.diag.join(" · ").substring(0, 60)}]` }));
            list = list.concat(got);
            // 화질이 하나뿐이면 원래 목록 주소도 함께 (재생기에 따라 이쪽이 잘 될 수 있음)
        }
        // 재생 목록 주소가 .m3u8 로 끝나지 않으면(master.txt 등) 망가요미 재생기가 HLS 로 알아보지 못하고
        // 조각을 하나씩 따로 재생함(10초짜리로 끊김) → 재생용 주소(originalUrl) 끝에 "#download.m3u8" 를 붙여 HLS 로 알림.
        // # 뒤는 서버로 보내지지 않아 실제 요청은 그대로 (DC 애니24 망가요미판과 같은 방법)
        for (const v of list) {
            const plain = String(v.url || "").replace(/#.*$/, "");
            v.originalUrl = /\.m3u8?$/i.test(plain.split("?")[0]) ? plain : plain + "#download.m3u8";
        }
        if (!list.length) {
            const wv = typeof evaluateJavascriptViaWebview === "function" ? "" : " · 웹뷰 미지원";
            throw new Error(`영상 주소를 찾지 못했습니다 [${fails.join(", ")}${wv} · ${this.diag.join(" · ")}]`);
        }
        return qualitySort("ohli24_quality", list);
    }

    /**
     * 화질 나누기. 이 플레이어의 재생 목록은 주소 끝에 .m3u8 이 없으므로(/m3/…, master.txt)
     * 주소 모양 대신 내용(#EXTM3U)을 보고 화질 목록이면 화질별로 나눔 (자동 화질 바꿈으로 자주 멈추는 것을 피하게)
     */
    /** DC 애니24(망가요미판)의 재생 부분을 그대로 옮김: 별도 통신(Client 옵션)으로 POST → securedLink → 화질 목록 */
    async dcVideos(player, origin, label) {
        const transports = [
            { persistentConnection: false, noProxy: true, timeout: 25, connectTimeout: 10 },
            { useDartHttpClient: true, persistentConnection: false },
        ];
        const req = async (fn) => {
            let last = null;
            for (const opt of transports) {
                try {
                    const r = await fn(new Client(opt));
                    if (r && r.statusCode >= 200 && r.statusCode < 300) return String(r.body || "");
                    last = `HTTP${r ? r.statusCode : "?"}`;
                } catch (e) {
                    last = String((e && e.message) || e).substring(0, 40);
                }
            }
            throw new Error(last || "실패");
        };
        try {
            let id = player.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
            if (!/^[a-f0-9]{16,}$/i.test(id)) {
                const embedded = await req((c) => c.get(player, { "User-Agent": UA, "Referer": this.getBaseUrl() + "/" }));
                const fm = embedded.match(/FirePlayer\s*\(\s*["']([^"']+)/i);
                if (fm) id = fm[1];
            }
            if (!id) return [];
            const body = await req((c) => c.post(`${origin}/player/index.php?data=${encodeURIComponent(id)}&do=getVideo`, {
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                "Referer": player,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Origin": origin,
            }, { hash: id, r: "" }));
            const data = JSON.parse(body);
            let masterUrl = String(data.securedLink || data.link || "").replace(/\\\//g, "/");
            if (!masterUrl) return [];
            if (masterUrl.startsWith("//")) masterUrl = "https:" + masterUrl;
            else if (masterUrl.startsWith("/")) masterUrl = origin + masterUrl;
            const master = await req((c) => c.get(masterUrl, { "User-Agent": UA, "Accept": "*/*", "Referer": player }));
            const headers = { "User-Agent": UA, "Referer": `${origin}/`, "Origin": origin };
            const out = [];
            const lines = master.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
                let next = "";
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].trim() && lines[j].indexOf("#") !== 0) {
                        next = lines[j].trim();
                        break;
                    }
                }
                if (!next) continue;
                const height = (lines[i].match(/RESOLUTION=\d+x(\d+)/i) || [])[1];
                const u = /^https?:\/\//.test(next) ? next : next.startsWith("/") ? (/^(https?:\/\/[^/]+)/.exec(masterUrl) || [null, ""])[1] + next : masterUrl.replace(/[?#].*$/, "").replace(/[^/]*$/, "") + next;
                out.push({ url: u, originalUrl: u, quality: height ? `${label} ${height}p` : label, headers, subtitles: [] });
            }
            if (!out.length) out.push({ url: masterUrl, originalUrl: masterUrl, quality: `${label} 자동`, headers, subtitles: [] });
            return out;
        } catch (e) {
            this.diag.push(`DC방식 ${String((e && e.message) || e).substring(0, 50)}`);
            return [];
        }
    }

    /** 플레이어 화면(cdndania.com/video/…)의 스크립트에서 securedLink 를 찾음 (압축된 스크립트는 풀어서) */
    async playerPage(player, pageUrl) {
        try {
            const res = await this.client.get(player, { "User-Agent": UA, "Referer": pageUrl });
            if (res.statusCode >= 400) {
                this.diag.push(`플레이어 ${res.statusCode}`);
                return null;
            }
            let html = String(res.body || "");
            const packed = html.match(/eval\(function\(p,a,c,k,e,[dr]\)[\s\S]*?\.split\('\|'\)[^)]*\)\)/g) || [];
            for (const p of packed) html += "\n" + unpack(p);
            const text = html.replace(/\\\//g, "/");
            const m = /securedLink"?\s*:\s*"([^"]+)"/.exec(text);
            if (m && /^https?:\/\//.test(m[1])) return { url: m[1], sure: true };
            this.diag.push(`플레이어에 securedLink 없음${packed.length ? "(압축 " + packed.length + ")" : ""}`);
            return null;
        } catch (e) {
            this.diag.push(`플레이어 열기 실패 ${String((e && e.message) || e).substring(0, 40)}`);
            return null;
        }
    }

    async expand(url, label, h) {
        if (/\.m3u8/.test(url)) return hlsExpand(this.client, url, label, h);
        const one = [{ url, originalUrl: url, quality: label, headers: h }];
        if (/\.mp4(\?|$)/.test(url)) return one;
        let body = "";
        try {
            const res = await this.client.get(url, h);
            if (Number(res.statusCode) >= 400) return one;
            body = String(res.body || "").replace(/\r/g, "");
        } catch (e) {
            return one;
        }
        if (!body.trim().startsWith("#EXTM3U")) return one;
        const origin = (/^(https?:\/\/[^/]+)/.exec(url) || [null, ""])[1];
        const dir = url.replace(/[^/]*(?:\?.*)?$/, "");
        const seen = {};
        const variants = [];
        const re = /#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)/g;
        let m;
        while ((m = re.exec(body))) {
            const hh = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
            const height = hh ? Number(hh[1]) : 0;
            let u = m[2].trim();
            if (!/^https?:\/\//.test(u)) u = u.startsWith("/") ? origin + u : dir + u;
            const key = height || u;
            if (seen[key]) continue;
            seen[key] = true;
            variants.push({ h: height, u });
        }
        if (!variants.length) {
            // 화질이 하나뿐인 재생 목록: 조각 주소의 화질(예: /720p/)을 이름에 붙임
            const r = /\/(2160|1440|1080|720|480|360)p\//.exec(body);
            return [{ url, originalUrl: url, quality: r ? `${label} ${r[1]}p` : label, headers: h }];
        }
        variants.sort((a, b) => b.h - a.h);
        if (variants.length === 1) return [{ url: variants[0].u, originalUrl: variants[0].u, quality: variants[0].h ? `${label} ${variants[0].h}p` : label, headers: h }];
        return variants.map((v) => ({ url: v.u, originalUrl: v.u, quality: v.h ? `${label} ${v.h}p` : label, headers: h }))
            .concat([{ url, originalUrl: url, quality: `${label} 자동 (최대 ${variants[0].h}p)`, headers: h }]);
    }

    /**
     * 플레이어(michealcdn 등)가 스스로 부르는 영상 주소 요청을 그대로 함:
     * POST {플레이어}/player/index.php?data={영상ID}&do=getVideo (hash={영상ID}, r={회차 화면}) → 응답 안의 m3u8
     */
    async firePlayer(player, pageUrl) {
        const m = /^(https?:\/\/[^/]+)\/.*?([^/?#]+)(?:[?#].*)?$/.exec(player);
        if (!m) return null;
        try {
            // DC 애니24와 같게: Referer·Origin 은 플레이어 주소의 앞부분, 본문은 hash={영상ID}, r=(빈 값)
            const res = await this.client.post(`${m[1]}/player/index.php?data=${m[2]}&do=getVideo`, {
                "X-Requested-With": "XMLHttpRequest",
                "Referer": m[1],
                "Origin": m[1],
            }, { hash: m[2], r: "" });
            const text = String(res.body || "").replace(/\\\//g, "/");
            if (res.statusCode >= 400) {
                this.diag.push(`요청 ${res.statusCode}`);
                return null;
            }
            // 애니요미와 같이 응답 안의 첫 .m3u8 주소를 먼저 씀. /m3/… 주소는 앞부분 몇 초짜리 목록이라
            // 재생기가 실시간 방송처럼 몇 초마다 목록을 다시 받으며 멈춤 → .m3u8 이 없을 때만 다른 주소
            // 응답의 securedLink 가 영상 전체 재생 목록 (다른 애니24 확장앱도 이 칸을 씀).
            // videoSource(/m3/…)는 앞부분 몇 초짜리라 재생기가 실시간 방송처럼 몇 초마다 멈춤
            let data = null;
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = null;
            }
            const secured = data && typeof data.securedLink === "string" && /^https?:\/\//.test(data.securedLink) ? data.securedLink : null;
            if (secured) return { url: secured, sure: true };
            const m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(text);
            if (m3u8) return { url: m3u8[0], sure: true };
            const pick = data && ["videoSource", "file", "hls", "src"].map((k) => data[k])
                .find((v) => typeof v === "string" && /^https?:\/\//.test(v));
            const v = pick || (/https?:\/\/[^"'\s<>]+(?:\/m3\/|master\.txt)[^"'\s<>]*/.exec(text) || [])[0];
            if (!v) this.diag.push(`응답 "${text.replace(/\s+/g, " ").substring(0, 60)}"`);
            return v ? { url: v, sure: false } : null;
        } catch (e) {
            this.diag.push(`요청 실패 ${String((e && e.message) || e).substring(0, 40)}`);
            return null;
        }
    }

    /** 숨은 웹뷰로 플레이어를 열고, 플레이어가 부른 m3u8 주소를 돌려받음 */
    async viaWebview(player, pageUrl) {
        if (typeof evaluateJavascriptViaWebview !== "function") return null;
        // .m3u8 주소를 먼저 찾고, 8초가 지나도 없으면 /m3/… · master.txt 주소라도 돌려줌
        const script = "(function(){var n=0;function find(re){var r=performance.getEntriesByType('resource');" +
            "for(var i=0;i<r.length;i++){if(re.test(r[i].name))return r[i].name;}return null;}" +
            "var t=setInterval(function(){n++;var u=find(/\\.m3u8(\\?|$)/)||(n>26?find(/\\/m3\\/|master\\.txt/):null);" +
            "if(u){clearInterval(t);window.flutter_inappwebview.callHandler('setResponse',u);return;}" +
            "if(n===20){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.jw-icon-display,.vjs-big-play-button,.plyr__control--overlaid');if(b)b.click();}},300);})();";
        try {
            const timeout = new Promise((res) => setTimeout(() => res(null), 20000));
            const res = await Promise.race([evaluateJavascriptViaWebview(player, { "Referer": pageUrl }, [script]), timeout]);
            if (!res) this.diag.push("웹뷰에서도 못 찾음");
            return res && /^https?:\/\//.test(String(res)) ? String(res) : null;
        } catch (e) {
            return null;
        }
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const host = this.getBaseUrl().replace(/^https?:\/\//, "");
        return [
            { type_name: "HeaderFilter", name: `📡 주소: ${host}` },
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), ruleFilters("ohli24", RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [{
            key: "ohli24_domain",
            editTextPreference: {
                title: "애니24 주소 직접 지정 (선택)",
                summary: `비워 두면 기본 주소(${DEFAULT_BASE_URL})를 사용합니다.`,
                value: "",
                dialogTitle: "애니24 주소",
                dialogMessage: "https:// 로 시작하는 애니24 주소 (예: https://www.ohli24.net)",
            },
        }, qualityPreference("ohli24_quality")];
    }
}
