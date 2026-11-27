const mangayomiSources = [{
    "id": 1543279657,
    "name": "[시험] 짭플릭스",
    "lang": "ko",
    "baseUrl": "https://zzap208.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": true,
    "hasCloudflare": false,
    "version": "0.0.12",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/zzap208.js"
}];

// 0.0.11 (2026-11-26): 이름을 짭플릭스로 변경
// 0.0.10 (2026-11-26): 검색(search.php?sfl=…&sop=and&keyword=)·분류(영화/드라마/숏드/예능/애니)·정렬(인기순) 필터, 인기 탭=vodlist 인기순, 작품 주소(vodview.php)만 카드로
// 0.0.9 (2026-11-26): 회차가 여러 개인데 1개만 보임(회차 이름 번호가 모두 26 으로 읽혀 합쳐짐) → 이름 앞에 번호 붙임
// 0.0.8 (2026-11-26): 회차 화면이 HTTP 202·본문 2020자(보안 확인 화면으로 추정) → 오류에 본문 글자·원문 앞부분·AWS 보안확인 여부를 표시(내용 확인용)
// 0.0.7 (2026-11-26): 영상 서버는 mp4 직접 재생이 막혀 있고(403), 플레이어 화면(chaktt.php, Referer 가 작품 화면일 때만 열림)의 phpsiteEc 를 풀면 wiselife.blog/hls/…m3u8?t&n&s 주소가 나옴 → 이것을 1순위 HLS 로 (주소는 요청마다 새로 만들어지므로 재생 직전에 풀어야 함)
// 0.0.6 (2026-11-26): 재생 아이콘 뒤 무한 로딩 → 영상 주소를 Referer 3가지로 앞 2바이트 받아 보고(화질 이름에 [상태] 표시, 열리는 것 먼저), 플레이어 화면 안의 다른 영상 주소도 후보로, 결과는 필터 위쪽 진단에
// 0.0.5 (2026-11-26): 참고 파일(tvwiki·tvroom) 반영 — Client 제한시간 설정, 영상 요청에 Origin·Accept 추가, 202 실패 시 웹뷰로 사이트 확인(쿠키 공유) 안내
// 0.0.4 (2026-11-26): 회차 화면이 HTTP 202·본문 0자(x-amz-cf 만)로 와서 재생 실패 → 브라우저와 같은 머리글 추가, 6번까지 점점 늦춰 재시도, 시도별 코드/글자수를 오류에 표시
// 0.0.3 (2026-11-26): 사용자가 보낸 작품 화면 HTML 로 정확한 칸 반영 — 회차 .episode-content-item li.content-box h1 a (?id=&idd=), 영상은 iframe 주소의 url= 뒤 mp4, 제목/줄거리/분류, 상대주소(?id=) 버그 고침
// 0.0.2 (2026-11-26): 작품 화면이 HTTP 202 로 와서 실패(목록은 성공) → 202 도 본문이 충분하면 읽고, 아니면 재시도 후 머리글·본문 앞부분을 오류에 표시
// [시험] 짭플릭스 0.0.1 (2026-11-26 사용자 요청)
// 주의: 제작 환경(해외)에서는 사이트가 국가 차단(CloudFront 403)이라 화면 구조를 직접 보지 못함.
// 그래서 특정 칸 이름에 기대지 않고 "그림이 든 링크 = 작품 카드", "같은 모양 주소가 가장 많은 링크 묶음 = 회차",
// "화면 글자 속 m3u8/mp4 주소·iframe 따라가기 = 영상" 으로 추측해서 읽음. 실패하면 오류 끝과 필터 위쪽에 진단이 남음.
// → 휴대폰에서 시험한 결과(오류 진단 글)를 보고 정확한 칸으로 고칠 것.
const SITE = "https://zzap208.com";
const START = "/mobile/";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const F_PATH = "목록 주소 (비우면 /mobile/)";
const F_PAGE = "쪽 번호 변수 이름 (기본 page)";
const F_CAT = "분류";
const F_ORDER = "정렬";
// 0.0.10: 사용자가 보낸 카테고리·검색 화면 기준 — 분류 vodlist.php?type_id_1=N&order_type=, 인기 order_type=vod_hits, 검색 search.php?sfl=…&sop=and&keyword=
const CATS = [["전체", ""], ["영화", "1"], ["드라마", "2"], ["숏드", "39"], ["예능프로그램", "3"], ["애니", "4"]];
const ORDERS = [["기본(최신)", ""], ["인기순", "vod_hits"]];
const SEARCH_PATH = "/mobile/search.php?sfl=" + encodeURIComponent("common_title||season_title||tag_title") + "&sop=and&keyword=";

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client({ timeout: 20, connectTimeout: 8 });
    }

    getHeaders(url) {
        return {
            "User-Agent": UA,
            "Referer": SITE + "/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-User": "?1",
        };
    }

    get supportsLatest() {
        return true;
    }

    diag(msg) {
        try {
            const prefs = new SharedPreferences();
            const old = String(prefs.get("diag") || "").split("\n").filter((x) => x);
            old.push(String(msg).substring(0, 160));
            while (old.length > 8) old.shift();
            prefs.set("diag", old.join("\n"));
        } catch (e) {
            // 저장 못 해도 계속
        }
    }

    shape(url) {
        return String(url).replace(/^https?:\/\//, "").substring(0, 70);
    }

    async page(url, stage, referer) {
        let res = null;
        let err = "";
        // 0.0.2: 202(받음, 아직 본문 없음/확인 화면) 은 잠시 뒤 다시 — 두 번째부터 목록 화면을 Referer 로
        const codes = [];
        const waits = [700, 1500, 2500, 4000, 6000];
        for (let i = 0; i < 6; i++) {
            try {
                const h = this.getHeaders(url);
                h["Referer"] = i >= 1 ? SITE + START : (referer || SITE + "/");
                res = await this.client.get(url, h);
                err = "";
                codes.push(res.statusCode + "/" + String(res.body || "").length);
            } catch (e) {
                res = null;
                codes.push("x");
                err = String((e && e.message) || e).substring(0, 60);
            }
            if (res && res.statusCode === 200) break;
            if (res && res.statusCode === 202 && String(res.body || "").length > 3000 && /<a\s/i.test(String(res.body))) break;
            if (i < 5) await new Promise((ok) => setTimeout(ok, waits[i]));
        }
        if (!res) {
            const m = `사이트에 연결하지 못했어요 [${stage} · ${err} · ${this.shape(url)}]`;
            this.diag(m);
            throw new Error(m);
        }
        const body = String(res.body || "");
        if (res.statusCode !== 200 && !(res.statusCode === 202 && body.length > 3000 && /<a\s/i.test(body))) {
            let hd = "";
            try {
                const h = res.headers || {};
                hd = Object.keys(h).filter((k) => /waf|cf-|server|content-type|location|set-cookie|refresh/i.test(k)).map((k) => `${k}=${String(h[k]).substring(0, 40)}`).join(";");
            } catch (e) {
                hd = "";
            }
            const waf = /awswaf|aws-waf|challenge|captcha|AwsWaf/i.test(body) ? "AWS 보안확인 화면 · " : "";
            const snip = waf + body.replace(/<script[\s\S]*?<\/script>/gi, " [script] ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 90) + " ⟨원문앞⟩ " + body.replace(/\s+/g, " ").substring(0, 140);
            const m = `사이트가 응답하지 않아요(보안 확인일 수 있음 — 화면 아래 웹뷰 버튼으로 이 회차를 한 번 열어 둔 뒤 재시도) [${stage} · HTTP ${res.statusCode} · 본문 ${body.length}자 · ${this.shape(url)} · 시도 ${codes.join(",")} · 머리글 ${hd} · 본문 앞 ${snip}]`;
            this.diag(m);
            throw new Error(m);
        }
        return body;
    }

    abs(u, base) {
        u = String(u || "").trim().replace(/&amp;/g, "&");
        if (!u || u.startsWith("#") || /^(?:javascript|mailto|tel):/i.test(u)) return "";
        if (u.startsWith("//")) return "https:" + u;
        if (/^https?:\/\//i.test(u)) return u;
        const b = String(base || SITE + START);
        if (u.startsWith("/")) return /^https?:\/\/[^/]+/i.exec(b)[0] + u;
        if (u.startsWith("?")) return b.replace(/[?#].*$/, "") + u;
        return b.replace(/[?#].*$/, "").replace(/\/[^/]*$/, "/") + u;
    }

    imgOf(el, base) {
        const imgs = el.select("img");
        if (!imgs.length) return "";
        return this.abs(imgs[0].attr("data-src") || imgs[0].attr("data-original") || imgs[0].attr("data-lazy-src") || imgs[0].attr("src"), base);
    }

    /** 목록 화면 → 카드: 그림이 든 링크 */
    cards(html, base) {
        const doc = new Document(html);
        const list = [];
        const seen = {};
        const self = base.replace(/[?#].*$/, "");
        for (const a of doc.select("a[href]")) {
            const link = this.abs(a.attr("href"), base);
            if (!link || seen[link] || link.replace(/[?#].*$/, "") === self) continue;
            if (!/^https?:\/\/(?:www\.)?zzap208\.com/i.test(link)) continue;
            const img = this.imgOf(a, base);
            if (!img) continue;
            const imgs = a.select("img");
            let name = (a.attr("title") || "").trim() || (imgs.length ? (imgs[0].attr("alt") || "").trim() : "") || a.text.replace(/\s+/g, " ").trim();
            if (!name) name = link.split(/[/?=&]/).filter((x) => x).pop();
            seen[link] = true;
            list.push({ name: name.substring(0, 120), imageUrl: img, link });
        }
        // 작품 주소(vodview.php)가 있으면 그것만 (광고·메뉴 그림 링크 빼기)
        const only = list.filter((x) => /vodview\.php/i.test(x.link));
        return only.length ? only : list;
    }

    async listing(path, page, pageVar, opts) {
        let p = String(path || "").trim() || START;
        if (!p.startsWith("/") && !/^https?:\/\//i.test(p)) p = "/" + p;
        let url = /^https?:\/\//i.test(p) ? p : SITE + p;
        if (page > 1) url += (url.includes("?") ? "&" : "?") + (pageVar || "page") + "=" + page;
        const list = this.cards(await this.page(url, "목록"), url);
        if (!list.length) {
            const m = `작품 카드를 못 찾았어요 [목록 · 카드 0 · ${this.shape(url)}]`;
            this.diag(m);
            throw new Error(m);
        }
        return { list, hasNextPage: list.length >= (opts && opts.minNext ? opts.minNext : 8) };
    }

    vodlist(cat, order) {
        return `/mobile/vodlist.php?type_id_1=${cat || ""}&order_type=${order || ""}`;
    }

    async getPopular(page) {
        return this.listing(this.vodlist("", "vod_hits"), page, "page");
    }

    async getLatestUpdates(page) {
        return this.listing(START, page, "page");
    }

    async search(query, page, filters) {
        const q = String(query || "").trim();
        const fl = filters || [];
        const get = (n) => fl.find((x) => x && x.name === n);
        const f = get(F_PATH);
        const pv = get(F_PAGE);
        const pageVar = pv && String(pv.state || "").trim() ? String(pv.state).trim() : "page";
        if (/^https?:\/\/(?:www\.)?zzap208\.com\//i.test(q)) {
            const d = await this.getDetail(q);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: q }], hasNextPage: false };
        }
        if (q) {
            return this.listing(SEARCH_PATH + encodeURIComponent(q), page, pageVar, { minNext: 20 });
        }
        const custom = f ? String(f.state || "").trim() : "";
        if (custom) return this.listing(custom, page, pageVar);
        const c = get(F_CAT);
        const o = get(F_ORDER);
        const ci = c ? Number(c.state) || 0 : 0;
        const oi = o ? Number(o.state) || 0 : 0;
        if (!ci && !oi) return this.listing(START, page, pageVar);
        return this.listing(this.vodlist((CATS[ci] || CATS[0])[1], (ORDERS[oi] || ORDERS[0])[1]), page, pageVar);
    }

    pattern(href) {
        return href.replace(/[?#].*$/, "").replace(/\d+/g, "#") + "?" + (/\?(.*)$/.exec(href) || ["", ""])[1].replace(/=[^&]*/g, "=");
    }

    async getDetail(url) {
        const link = this.abs(url);
        const html = await this.page(link, "작품");
        const doc = new Document(html);
        const meta = (p) => {
            const m = doc.select(`meta[property='${p}']`);
            return m.length ? String(m[0].attr("content") || "").trim() : "";
        };
        const strip = (t) => String(t || "").replace(/\s*-\s*짭플릭스.*$/, "").replace(/\s+\d{2}\/\d{2}\/\d{2}\s*$/, "").trim();
        let name = "";
        const h1 = doc.select(".share-title h1");
        if (h1.length) name = strip(h1[0].text);
        if (!name) name = strip(meta("og:title"));
        if (!name) {
            const t = doc.select("title");
            name = t.length ? strip(t[0].text) : "";
        }
        const th = doc.select(".episode-content-item .thumb img");
        const imageUrl = this.abs(th.length ? (th[0].attr("data-src") || th[0].attr("src")) : meta("og:image"), link);
        const ps = doc.select(".overview p").map((p) => p.text.trim()).filter((t) => t && !/^#/.test(t));
        const description = ps.length ? ps.join("\n\n") : meta("og:description");
        const gs = doc.select(".datetime-hit span").map((x) => x.text.trim()).filter((t) => t);
        const tags = doc.select(".overview .tagline").map((x) => x.text.trim().replace(/^#/, "")).filter((t) => t);
        const genre = gs.slice(0, 1).concat(tags);

        const chapters = [];
        const seen = {};
        for (const a of doc.select(".episode-content-item li.content-box h1 a")) {
            const href = this.abs(a.attr("href"), link);
            if (!href || seen[href]) continue;
            seen[href] = true;
            const nm = a.text.replace(/\s+/g, " ").trim() || `${chapters.length + 1}화`;
            const dm = /(\d{2})\/(\d{2})\/(\d{2})\s*$/.exec(nm);
            const at = dm ? Date.UTC(2000 + Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])) - 9 * 36e5 : null;
            chapters.push({ name: nm, url: href, dateUpload: at ? String(at) : null });
        }
        let groups = {};
        if (!chapters.length) {
            // 예비: 같은 모양 주소가 가장 많은 링크 묶음
            const self = link.replace(/[?#].*$/, "");
            for (const a of doc.select("a[href]")) {
                const href = this.abs(a.attr("href"), link);
                if (!href || !/^https?:\/\/(?:www\.)?zzap208\.com/i.test(href)) continue;
                const key = this.pattern(href);
                (groups[key] = groups[key] || []).push({ href, text: a.text.replace(/\s+/g, " ").trim(), title: (a.attr("title") || "").trim() });
            }
            let best = [];
            for (const k of Object.keys(groups)) {
                const g = groups[k].filter((x) => x.href.replace(/[?#].*$/, "") !== self || x.href.includes("?"));
                const uniq = new Set(g.map((x) => x.href));
                if (uniq.size >= 2 && uniq.size > new Set(best.map((x) => x.href)).size) best = g;
            }
            for (const x of best) {
                if (seen[x.href]) continue;
                seen[x.href] = true;
                chapters.push({ name: x.text || x.title || `${chapters.length + 1}화`, url: x.href, dateUpload: null });
            }
        }
        // 0.0.9: 망가요미는 회차 이름에서 읽은 번호가 같으면 한 개로 합쳐 보여 줌 — 이름이 "작품명 26/11/26"·"26/11/19" 처럼 날짜뿐이라
        // 번호가 모두 26 으로 읽혀 1개만 남았음 → 맨 앞에 오래된 순 번호(1., 2., …)를 붙여 서로 다르게 함 (목록은 최신순이라 위가 큰 번호)
        if (chapters.length > 1) {
            const total = chapters.length;
            chapters.forEach((c, i) => {
                c.name = `${total - i}. ${c.name.replace(/^\s*\d+\.\s+/, "")}`;
            });
        }
        // 회차 묶음을 못 찾으면 작품 주소 자체를 1개 회차(영화·단편)로
        if (!chapters.length) chapters.push({ name: "본편", url: link, dateUpload: null });
        this.diag(`작품 읽음 [회차 ${chapters.length} · 묶음 ${Object.keys(groups).length} · ${this.shape(link)}]`);
        return { name, imageUrl, description, author: "", artist: "", genre, status: 5, link, chapters };
    }

    /** 화면 글자에서 영상 주소 찾기 */
    media(body, base) {
        const t = String(body || "").replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&");
        const out = [];
        const re = /(?:https?:)?\/\/[^\s"'<>\\()]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\()]*)?/gi;
        let m;
        while ((m = re.exec(t))) {
            const u = this.abs(m[0], base);
            if (u && out.indexOf(u) < 0) out.push(u);
        }
        const re2 = /(?:file|src|source|video_url|videoUrl|hls)\s*[:=]\s*["']([^"']+)["']/gi;
        while ((m = re2.exec(t))) {
            if (/\.(?:m3u8|mp4)(?:$|\?)/i.test(m[1])) {
                const u = this.abs(m[1], base);
                if (u && out.indexOf(u) < 0) out.push(u);
            }
        }
        return out;
    }

    /** 플레이어 화면의 phpsiteEc 를 풀어 HLS 주소로 (common.js: base64 → "phpsite01" 반복 XOR → base64) */
    b64(data) {
        const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        data = String(data || "");
        let out = "";
        let i = 0;
        while (i < data.length) {
            const h1 = T.indexOf(data.charAt(i++));
            const h2 = T.indexOf(data.charAt(i++));
            const h3 = T.indexOf(data.charAt(i++));
            const h4 = T.indexOf(data.charAt(i++));
            const bits = (h1 << 18) | (h2 << 12) | (h3 << 6) | h4;
            const o1 = (bits >> 16) & 0xff;
            const o2 = (bits >> 8) & 0xff;
            const o3 = bits & 0xff;
            if (h3 === 64) out += String.fromCharCode(o1);
            else if (h4 === 64) out += String.fromCharCode(o1, o2);
            else out += String.fromCharCode(o1, o2, o3);
        }
        return out;
    }

    decodePlayer(html) {
        const e = /phpsiteEc\s*=\s*["']([^"']+)["']/.exec(html);
        const k = /phpsitekey\s*=\s*["']([^"']+)["']/.exec(html);
        if (!e || !k) return "";
        const raw = this.b64(e[1]);
        let x = "";
        for (let i = 0; i < raw.length; i++) x += String.fromCharCode(raw.charCodeAt(i) ^ k[1].charCodeAt(i % k[1].length));
        const u = this.b64(x).trim();
        return /^https?:\/\//i.test(u) ? u : "";
    }

    async getVideoList(url) {
        const link = this.abs(url);
        const logs = [];
        const queue = [{ url: link, referer: SITE + "/" }];
        const queued = { [link]: true };
        for (let i = 0; i < queue.length && i < 6; i++) {
            const item = queue[i];
            let body;
            try {
                body = await this.page(item.url, i === 0 ? "회차" : "플레이어", item.referer);
            } catch (e) {
                logs.push(String(e.message || e).substring(0, 420));
                continue;
            }
            const found = [];
            if (i === 0) {
                // 짭플릭스: <iframe src="https://…/chaktt.php?url=https://…/영상.mp4"> — 영상 주소가 url= 뒤에 그대로
                for (const f of new Document(body).select("iframe")) {
                    const src = String(f.attr("src") || f.attr("data-src") || "").replace(/&amp;/g, "&");
                    const um = /[?&]url=([^&"'\s]+)/.exec(src);
                    if (!um) continue;
                    let v = um[1];
                    try { v = decodeURIComponent(v); } catch (e) { /* 그대로 */ }
                    if (/^https?:\/\//i.test(v) && found.indexOf(v) < 0) {
                        found.push(v);
                        this.player = /^https?:\/\/[^/]+/i.exec(this.abs(src, item.url))[0] + "/";
                    }
                }
            }
            if (!found.length) for (const u of this.media(body, item.url)) found.push(u);
            logs.push(`${i === 0 ? "회차" : "플레이어"} ${this.shape(item.url)} · 영상 ${found.length}`);
            if (found.length) {
                const origin = /^https?:\/\/[^/]+/i.exec(item.url)[0];
                const refs = this.player ? [this.player, item.url, ""] : [item.url, ""];
                // 0.0.6: 플레이어 화면(chaktt.php)이 따로 가리키는 영상 주소도 후보에 추가
                let pbody = "";
                if (this.player) {
                    try {
                        const pu = this.abs((/<iframe[^>]+src=["']([^"']*chaktt[^"']*)/i.exec(body) || [])[1], item.url);
                        const pr = await this.client.get(pu, { "User-Agent": UA, "Referer": item.url, "Accept": "text/html,*/*" });
                        pbody = String(pr.body || "");
                        logs.push(`플레이어화면 HTTP ${pr.statusCode} ${pbody.length}자`);
                        const hls = this.decodePlayer(pbody);
                        logs.push(`HLS 해독 ${hls ? "성공" : "실패"}`);
                        if (hls) found.unshift(hls);
                        for (const u of this.media(pbody, pu)) if (found.indexOf(u) < 0 && !/chaktt\.php/.test(u)) found.push(u);
                    } catch (e) {
                        logs.push(`플레이어화면 실패 ${String((e && e.message) || e).substring(0, 40)}`);
                    }
                }
                const res = [];
                const cand = found.slice(0, 3);
                const hlsRefs = this.player ? [this.player, ""] : [""];
                for (let k = 0; k < cand.length; k++) {
                    const u = cand[k];
                    for (let j = 0; j < refs.length; j++) {
                        const rf = refs[j];
                        if (/\.m3u8/i.test(u) && hlsRefs.indexOf(rf) < 0) continue;
                        const headers = { "User-Agent": UA, "Accept": "*/*" };
                        if (rf) {
                            headers["Referer"] = rf;
                            headers["Origin"] = rf.replace(/^(https?:\/\/[^/]+).*$/, "$1");
                        }
                        // 실제로 열리는지 앞 2바이트만 받아 봄
                        let st = "?";
                        let ct = "";
                        try {
                            const pr = await this.client.get(u, { ...headers, "Range": "bytes=0-1" });
                            st = String(pr.statusCode);
                            try { ct = String((pr.headers || {})["content-type"] || (pr.headers || {})["Content-Type"] || "").substring(0, 20); } catch (e) { ct = ""; }
                        } catch (e) {
                            st = "오류";
                        }
                        logs.push(`영상${k + 1} ${j === 0 && this.player ? "플레이어" : rf ? "사이트" : "없음"}Referer → ${st} ${ct}`);
                        res.push({
                            url: u,
                            originalUrl: u,
                            quality: `${/\.m3u8/i.test(u) ? "HLS" : "MP4"} ${k + 1} · ${rf ? (rf === this.player ? "플레이어" : "사이트") : "Referer 없음"} [${st}]`,
                            headers,
                            ok: st === "200" || st === "206",
                        });
                    }
                }
                this.diag(logs.join(" | "));
                // 열리는 것을 앞에, 안 열리는 것은 뒤에 (그래도 남겨 둠)
                res.sort((x, y) => (y.ok ? 1 : 0) - (x.ok ? 1 : 0));
                return res.map((x) => ({ url: x.url, originalUrl: x.originalUrl, quality: x.quality, headers: x.headers }));
            }
            const doc = new Document(body);
            for (const f of doc.select("iframe").slice(0, 6)) {
                const u = this.abs(f.attr("data-src") || f.attr("src"), item.url);
                if (u && !queued[u]) {
                    queued[u] = true;
                    queue.push({ url: u, referer: item.url });
                }
            }
            logs.push(`iframe ${doc.select("iframe").length}`);
        }
        const msg = `영상 주소를 찾지 못했어요 [${logs.join(" | ")}]`.substring(0, 900);
        this.diag(msg);
        throw new Error(msg);
    }

    getFilterList() {
        let diag = [];
        try {
            diag = String(new SharedPreferences().get("diag") || "").split("\n").filter((x) => x);
        } catch (e) {
            diag = [];
        }
        return [
            { type_name: "HeaderFilter", name: `[시험] 짭플릭스 ${mangayomiSources[0].version} · 분류·정렬은 검색어 없이 필터 적용 (아래는 최근 진단)` },
            ...diag.map((name) => ({ type_name: "HeaderFilter", name })),
            { type_name: "SelectFilter", name: F_CAT, state: 0, values: CATS.map((x) => ({ type_name: "SelectOption", name: x[0], value: x[1] })) },
            { type_name: "SelectFilter", name: F_ORDER, state: 0, values: ORDERS.map((x) => ({ type_name: "SelectOption", name: x[0], value: x[1] })) },
            { type_name: "TextFilter", name: F_PATH, state: "" },
            { type_name: "TextFilter", name: F_PAGE, state: "page" },
            ...[1, 2, 3].map(() => ({ type_name: "HeaderFilter", name: "　" })),
        ];
    }

    getSourcePreferences() {
        return [];
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
