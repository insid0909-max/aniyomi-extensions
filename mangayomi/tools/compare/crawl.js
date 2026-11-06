// 애니·드라마 확장 전체 작품 목록 받기 (2026-11-06, 웹툰 저장소 monitor/compare 와 같은 모양)
// 사용: node mangayomi/tools/compare/crawl.js <확장키> <저장할.tsv>   (확장키: gogotv ohli24 aniwolf tvchak anilife kotbc)
// 결과: 한 줄에 "주소<TAB>제목". 망가요미 파일을 그대로 돌림 — 해외에서 막힌 사이트(티비착·애니라이프·코티비씨, 403)는 못 받음.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..", "..", "..");
const { loadExtension } = require(path.join(ROOT, "mangayomi", "tools", "monitor", "runtime.js"));
const [key, out] = process.argv.slice(2);

// 사이트마다 "전체"를 받는 방법: 필터 이름(또는 param) → 고를 칸 번호
const range = (n) => [...Array(n).keys()];
const JOBS = {
    gogotv: range(6).map((i) => ({ 분류: i, 정렬: 0, 지역: 0 })),            // 드라마·영화·예능·TV프로·음악프로·애니
    ohli24: range(3).map((i) => ({ kind: i, order: 0 })),                    // 방영중·완결·극장판
    aniwolf: range(3).map((i) => ({ kind: i, sort: 0 })),                    // 방영중·종영·극장판
    tvchak: [{ type: 0, sort: 0 }],
    anilife: [{ scope: 0, sort: 1 }],
    kotbc: range(5).map((i) => ({ type: i, sort: 0 }))
};

(async () => {
    const o = loadExtension(path.join(ROOT, "mangayomi", "javascript", "anime", "src", "ko", `${key}.js`), {});
    const e = o.ext || o;
    const M = new Map();
    for (const job of JOBS[key]) {
        const fl = JSON.parse(JSON.stringify(e.getFilterList()));
        for (const x of fl) {
            const k = x.param in job ? x.param : x.name in job ? x.name : null;
            if (x.type_name === "SelectFilter" && k) x.state = job[k];
        }
        let bad = 0;
        for (let p = 1; p <= 2000; p++) {
            let r;
            try {
                r = await Promise.race([e.search("", p, fl), new Promise((_, j) => setTimeout(() => j(new Error("40초 넘음")), 40000))]);
            } catch (x) {
                console.log("오류", JSON.stringify(job), p, String(x.message).slice(0, 80));
                if (++bad > 2) break;
                continue;
            }
            const before = M.size;
            r.list.forEach((x) => M.set(x.link, x.name));
            if (p % 20 === 0) console.log(JSON.stringify(job), p, M.size);
            if (!r.hasNextPage || !r.list.length) break;
            bad = M.size === before ? bad + 1 : 0;
            if (bad > 2) break;
        }
        console.log("끝", JSON.stringify(job), M.size);
    }
    fs.writeFileSync(out, [...M].map(([l, t]) => `${l}\t${String(t).replace(/[\t\n]/g, " ")}`).join("\n") + "\n");
    console.log("저장", key, M.size);
    process.exit(0);
})();
