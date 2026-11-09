// 애니·웹툰·소설 망가요미 확장 목록을 파일 하나로 합침 (2026-11-09)
// 망가요미는 목록 파일 하나에서 확장마다 적힌 종류(itemType 0 웹툰·1 애니·2 소설)에 맞는 칸에만 보여 줌
// (순정 lib/services/fetch_sources_list.dart) → 웹툰·애니·소설 저장소 칸에 같은 주소 하나를 넣으면 됨
// 사용: node combine.js <애니 anime_index.json> <나갈 폴더>
// 개인 저장소(my-ext)는 넣지 않음 (사용자 요청 2026-11-09)
const fs = require("fs");
const path = require("path");

const WEBTOON = [
    "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/mangayomi/index.json",
    "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/mangayomi/novel_index.json",
];

async function getJson(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
            if (r.ok) {
                const v = await r.json();
                if (Array.isArray(v)) return v;
            }
        } catch (e) {
            // 다시
        }
        await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
    throw new Error("목록을 받지 못함: " + url);
}

(async () => {
    const [animeFile, outDir] = process.argv.slice(2);
    const anime = JSON.parse(fs.readFileSync(animeFile, "utf8"));
    const lists = [anime];
    for (const u of WEBTOON) lists.push(await getJson(u));
    const all = [];
    const ids = new Set();
    for (const list of lists) {
        if (!Array.isArray(list) || !list.length) throw new Error("빈 목록이 있어 합치지 않음");
        for (const s of list) {
            if (!s || s.id == null) continue;
            if (ids.has(s.id)) throw new Error("번호(id)가 겹침: " + s.id + " " + s.name);
            ids.add(s.id);
            all.push(s);
        }
    }
    // 종류 표시가 없으면 망가요미가 그 칸에 안 보여 줌
    for (const s of all) if (![0, 1, 2].includes(s.itemType)) throw new Error("종류(itemType) 없음: " + s.name);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(all, null, 1) + "\n");
    const count = (t) => all.filter((s) => s.itemType === t).length;
    console.log(`합침: 웹툰 ${count(0)} · 애니 ${count(1)} · 소설 ${count(2)} = ${all.length}`);
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
