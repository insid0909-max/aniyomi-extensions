const mangayomiSources = [{
    "id": 1543279657,
    "name": "[시험] zzap208",
    "lang": "ko",
    "baseUrl": "https://zzap208.com",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": true,
    "hasCloudflare": false,
    "version": "0.0.6",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/zzap208.js"
}];

// 0.0.6 (2026-11-26): 재생 아이콘 뒤 무한 로딩 → 영상 주소를 Referer 3가지로 앞 2바이트 받아 보고(화질 이름에 [상태] 표시, 열리는 것 먼저), 플레이어 화면 안의 다른 영상 주소도 후보로, 결과는 필터 위쪽 진단에
// 0.0.5 (2026-11-26): 참고 파일(tvwiki·tvroom) 반영 — Client 제한시간 설정, 영상 요청에 Origin·Accept 추가, 202 실패 시 웹뷰로 사이트 확인(쿠키 공유) 안내
// 0.0.4 (2026-11-26): 회차 화면이 HTTP 202·본문 0자(x-amz-cf 만)로 와서 재생 실패 → 브라우저와 같은 머리글 추가, 6번까지 점점 늦춰 재시도, 시도별 코드/글자수를 오류에 표시
// 0.0.3 (2026-11-26): 사용자가 보낸 작품 화면 HTML 로 정확한 칸 반영 — 회차 .episode-content-item li.content-box h1 a (?id=&idd=), 영상은 iframe 주소의 url= 뒤 mp4, 제목/줄거리/분류, 상대주소(?id=) 버그 고침
// 0.0.2 (2026-11-26): 작품 화면이 HTTP 202 로 와서 실패(목록은 성공) → 202 도 본문이 충분하면 읽고, 아니면 재시도 후 머리글·본문 앞부분을 오류에 표시
// [시험] zzap208 0.0.1 (2026-11-26 사용자 요청)
// 주의: 제작 환경(해외)에서는 사이트가 국가 차단(CloudFront 403)이라 화면 구조를 직접 보지 못함.
// 그래서 특정 칸 이름에 기대지 않고 "그림이 든 링크 = 작품 카드", "같은 모양 주소가 가장 많은 링크 묶음 = 회차",
// "화면 글자 속 m3u8/mp4 주소·iframe 따라가기 = 영상" 으로 추측해서 읽음. 실패하면 오류 끝과 필터 위쪽에 진단이 남음.
// → 휴대폰에서 시험한 결과(오류 진단 글)를 보고 정확한 칸으로 고칠 것.
const SITE = "https://zzap208.com";
const START = "/mobile/";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const F_PATH = "목록 주소 (비우면 /mobile/)";
const F_PAGE = "쪽 번호 변수 이름 (기본 page)";

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
            const snip = body.replace(/\s+/g, " ").substring(0, 140);
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
        return list;
    }

    async listing(path, page, pageVar) {
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
        return { list, hasNextPage: list.length >= 8 };
    }

    async getPopular(page) {
        return this.listing(START, page, "page");
    }

    async getLatestUpdates(page) {
        return this.listing(START, page, "page");
    }

    async search(query, page, filters) {
        const q = String(query || "").trim();
        const f = (filters || []).find((x) => x && x.name === F_PATH);
        const pv = (filters || []).find((x) => x && x.name === F_PAGE);
        const pageVar = pv && String(pv.state || "").trim() ? String(pv.state).trim() : "page";
        if (/^https?:\/\/(?:www\.)?zzap208\.com\//i.test(q)) {
            const d = await this.getDetail(q);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: q }], hasNextPage: false };
        }
        if (q) {
            // 검색 주소를 모르므로 흔한 모양을 차례로 시도 (사용자가 목록 주소 칸에 {q} 로 직접 쓸 수도 있음)
            const custom = f ? String(f.state || "").trim() : "";
            const tries = custom.includes("{q}") ? [custom.replace("{q}", encodeURIComponent(q))] : [
                `${START}search.php?q=${encodeURIComponent(q)}`,
                `${START}?s=${encodeURIComponent(q)}`,
                `${START}?q=${encodeURIComponent(q)}`,
                `/search?q=${encodeURIComponent(q)}`,
                `/?s=${encodeURIComponent(q)}`,
            ];
            let last = null;
            for (const t of tries) {
                try {
                    const r = await this.listing(t, page, pageVar);
                    if (r.list.length) return r;
                } catch (e) {
                    last = e;
                }
            }
            if (last) throw last;
            return { list: [], hasNextPage: false };
        }
        return this.listing(f ? f.state : "", page, pageVar);
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
                logs.push(String(e.message || e).substring(0, 100));
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
                        for (const u of this.media(pbody, pu)) if (found.indexOf(u) < 0 && !/chaktt\.php/.test(u)) found.push(u);
                    } catch (e) {
                        logs.push(`플레이어화면 실패 ${String((e && e.message) || e).substring(0, 40)}`);
                    }
                }
                const res = [];
                const cand = found.slice(0, 3);
                for (let k = 0; k < cand.length; k++) {
                    const u = cand[k];
                    for (let j = 0; j < refs.length; j++) {
                        const rf = refs[j];
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
        const msg = `영상 주소를 찾지 못했어요 [${logs.join(" | ")}]`.substring(0, 600);
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
            { type_name: "HeaderFilter", name: `[시험] zzap208 ${mangayomiSources[0].version} · 사이트 구조 미확인 추측판 (아래는 최근 진단)` },
            ...diag.map((name) => ({ type_name: "HeaderFilter", name })),
            { type_name: "TextFilter", name: F_PATH, state: "" },
            { type_name: "TextFilter", name: F_PAGE, state: "page" },
            ...[1, 2, 3].map(() => ({ type_name: "HeaderFilter", name: "　" })),
        ];
    }

    getSourcePreferences() {
        return [];
    }
}
