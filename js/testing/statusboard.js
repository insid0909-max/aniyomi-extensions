const mangayomiSources = [{
    "name": "[시험] 확장 상태판",
    "lang": "ko",
    "baseUrl": "https://insid0909-max.github.io/aniyomi-extensions/status/",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.0.1",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "js/testing/statusboard.js"
}];

// 확장 상태판 (2026-11-13, 사용자 "이걸 확장앱처럼 안되나" → 진행)
// 작품 대신 확장 하나가 카드 하나. 자료는 상태판 웹 화면(GitHub Pages /status/)과 같은 repo 가지 status.json,
// 회차 칸은 그 확장의 업데이트 내역(애니 master·웹툰 main changelog.json). 카드 그림은 상태 색 그림 4장.
const RAW = "https://raw.githubusercontent.com/insid0909-max/";
const DATA_URL = RAW + "aniyomi-extensions/repo/status.json";
const LOG_URLS = { anime: RAW + "aniyomi-extensions/master/changelog.json", webtoon: RAW + "aniyomi-manga-extensions/main/changelog.json" };
const IMG = RAW + "aniyomi-extensions/test/js/status-img/";
const PAGE = "https://insid0909-max.github.io/aniyomi-extensions/status/";
const MARK = { ok: "✅", bad: "❌", abroad: "🌐", none: "➖" };
const LABEL = { ok: "정상", bad: "문제", abroad: "해외에서 막혀 확인 못 함", none: "점검 안 함" };
const GROUPS = [["전체", ""], ["애니·드라마·스포츠", "anime"], ["웹툰·소설", "webtoon"]];
const STATES = [["전체", ""], ["문제", "bad"], ["정상", "ok"], ["해외 차단", "abroad"], ["점검 안 함", "none"]];

function kst(iso, withYear) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t + 9 * 3600000);
    const z = (n) => String(n).padStart(2, "0");
    return (withYear ? d.getUTCFullYear() + "." : "") + `${z(d.getUTCMonth() + 1)}.${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36" };
    }

    async json(url) {
        const r = await this.client.get(url + "?t=" + Math.floor(Date.now() / 60000), { "Cache-Control": "no-cache" });
        if (Number(r.statusCode) !== 200) throw new Error(`상태 자료를 받지 못했어요 (HTTP ${r.statusCode}). 잠시 뒤 다시 열어 주세요.`);
        return JSON.parse(String(r.body || "{}"));
    }

    async data() {
        if (this._data && Date.now() - this._at < 60000) return this._data;
        this._data = await this.json(DATA_URL);
        this._at = Date.now();
        return this._data;
    }

    items(d) {
        const out = [];
        for (const g of d.groups || []) for (const it of g.items || []) out.push(Object.assign({ group: g.id, groupTitle: g.title }, it));
        return out;
    }

    link(it) {
        // 웹뷰 버튼이 그 사이트를 열도록 사이트 주소에, 어느 확장인지는 # 뒤에 (사이트로는 안 감)
        return (it.link || PAGE) + "#st-" + it.group + "-" + it.key;
    }

    card(it) {
        return { name: `${MARK[it.state] || ""} ${it.name}`, imageUrl: IMG + (MARK[it.state] ? it.state : "none") + ".png", link: this.link(it) };
    }

    list(d, group, state, query) {
        const order = { bad: 0, ok: 1, abroad: 2, none: 3 };
        const q = String(query || "").replace(/\s+/g, "").toLowerCase();
        return this.items(d)
            .filter((it) => (!group || it.group === group) && (!state || it.state === state) && (!q || String(it.name).replace(/\s+/g, "").toLowerCase().includes(q) || String(it.addr).includes(q)))
            .map((it, i) => [it, i])
            .sort((a, b) => (state ? 0 : order[a[0].state] - order[b[0].state]) || a[1] - b[1])
            .map((x) => this.card(x[0]));
    }

    // 인기 = 전체(문제 있는 것이 맨 앞), 최신 = 문제 있는 것만(없으면 안내 카드)
    async getPopular(page) {
        const d = await this.data();
        return { list: page > 1 ? [] : this.list(d, "", "", ""), hasNextPage: false };
    }

    async getLatestUpdates(page) {
        const d = await this.data();
        let list = page > 1 ? [] : this.list(d, "", "bad", "");
        if (page === 1 && !list.length) list = [{ name: "✅ 문제 있는 확장이 없어요", imageUrl: IMG + "ok.png", link: PAGE + "#st-all" }];
        return { list, hasNextPage: false };
    }

    async search(query, page, filters) {
        const d = await this.data();
        const pick = (name, table) => {
            const f = (filters || []).find((x) => x && x.name === name);
            return f ? (table[Number(f.state) || 0] || table[0])[1] : "";
        };
        return { list: page > 1 ? [] : this.list(d, pick("분류", GROUPS), pick("상태", STATES), query), hasNextPage: false };
    }

    async getDetail(url) {
        const d = await this.data();
        const m = /#st-([a-z]+)-([a-z0-9]+)$/.exec(String(url));
        const runs = d.runs || {};
        if (!m) {
            return {
                name: "✅ 문제 있는 확장이 없어요", imageUrl: IMG + "ok.png", link: url, status: 5, genre: [],
                description: `감시 작업이 마지막으로 확인한 결과, 문제 있는 확장이 없어요.\n마지막 점검: 애니 ${kst(runs.anime)} · 웹툰 ${kst(runs.webtoon)}`,
                episodes: [],
            };
        }
        const it = this.items(d).find((x) => x.group === m[1] && x.key === m[2]);
        if (!it) throw new Error("상태판에서 이 확장을 찾지 못했어요. 목록을 새로 고쳐 주세요.");
        const run = runs[it.group];
        const stale = run && (Date.now() - Date.parse(run)) / 3600000 > 36;
        const check = it.state === "ok" ? `✅ 정상 · ${kst(it.checkedAt)} 점검 · ${it.msg}`
            : it.state === "bad" ? `❌ 문제 · ${it.since ? kst(it.since) + "부터 · " : ""}${kst(it.checkedAt)} 점검\n${it.msg}`
            : it.state === "abroad" ? "🌐 해외 서버에서 막혀 감시 작업이 못 열어요. 휴대폰에서 안 되면 그 확장 필터 맨 위 📡·🔎 줄을 찍어 보내 주세요."
            : "➖ 감시 작업이 매일 열어 보는 목록에 없는 확장이에요.";
        const desc = [
            check,
            `주소: ${it.addr}${it.link ? " (오른쪽 위 지구본을 누르면 사이트가 열려요)" : ""}`,
            `버전: ${[it.js && "망가요미 " + it.js, it.kt && "애니요미 있음"].filter(Boolean).join(" · ") || "-"}`,
            `감시 작업 마지막 실행: ${kst(run) || "기록 없음"}${stale ? " ⚠ 하루 넘게 멈춤 — GitHub Actions 가 꺼졌을 수 있어요" : ""}`,
            `상태판 자료: ${kst(d.generatedAt)}`,
            "아래 목록은 이 확장의 업데이트 내역이에요.",
        ].join("\n");
        let notes = [];
        try {
            const log = await this.json(LOG_URLS[it.group]);
            notes = ((log.items || {})[it.key] || []).slice(0, 30);
        } catch (e) {
            if (it.note) notes = [it.note];
        }
        const episodes = notes.map((n, i) => {
            const t = Date.parse(String(n.d) + "T12:00:00+09:00");
            return {
                name: `${notes.length - i}. ${String(n.d).slice(5).replace("-", ".")} ${String(n.t).replace(/^(망가요미|애니요미):\s*/, "")}`,
                url: this.link(it) + "-log" + i,
                dateUpload: Number.isFinite(t) ? String(t) : null,
                scanlator: /^애니요미/.test(n.t) ? "애니요미" : /^망가요미/.test(n.t) ? "망가요미" : "",
            };
        });
        return {
            name: `${MARK[it.state] || ""} ${it.name}`,
            imageUrl: IMG + (MARK[it.state] ? it.state : "none") + ".png",
            link: this.link(it),
            description: desc,
            author: it.groupTitle,
            status: 5,
            genre: [LABEL[it.state] || "", it.groupTitle].filter(Boolean),
            episodes,
        };
    }

    async getVideoList(url) {
        throw new Error("이 줄은 업데이트 내역이에요. 재생할 영상은 없어요.");
    }

    getFilterList() {
        const sel = (name, table) => ({
            type_name: "SelectFilter", name, state: 0,
            values: table.map((v, i) => ({ type_name: "SelectOption", name: v[0], value: String(i) })),
        });
        return [
            { type_name: "HeaderFilter", name: "인기 = 전체(문제 있는 것이 맨 앞) · 최신 = 문제 있는 것만" },
            sel("분류", GROUPS),
            sel("상태", STATES),
            { type_name: "HeaderFilter", name: "　" },
            { type_name: "HeaderFilter", name: "　" },
            { type_name: "HeaderFilter", name: "　" },
        ];
    }

    getSourcePreferences() {
        return [];
    }
}
