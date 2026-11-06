// 받은 목록(tsv)들로 겹침 표 만들기
// 사용: node mangayomi/tools/compare/analyze.js <폴더>   (폴더 안 *.tsv → 요약표를 화면에 출력)
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const NAMES = { gogotv: "고고티비", tvchak: "티비착", kotbc: "코티비씨", ohli24: "애니24", aniwolf: "애니울프", anilife: "애니라이프" };
// 제목 비교: 끝의 " (2026)"·" · 11.05" 표시와 띄어쓰기·기호를 빼고 비교
const norm = (t) => t.normalize("NFC").replace(/\s*·\s*\d\d\.\d\d\s*$/, "").replace(/(\s*\(\d{4}\))+\s*$/, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const T = {};
const count = {};
for (const k of Object.keys(NAMES)) {
    const f = path.join(dir, `${k}.tsv`);
    if (!fs.existsSync(f)) continue;
    const rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
    count[k] = rows.length;
    T[k] = new Set(rows.map((r) => norm(r[1] || "")).filter(Boolean));
}
const K = Object.keys(T);
const pct = (a, b) => Math.round((100 * [...T[a]].filter((x) => T[b].has(x)).length) / T[a].size);
console.log("| 확장 | 목록 | 제목 | 다른 데 없는 작품 |\n|---|---|---|---|");
for (const k of K) {
    const others = new Set(K.filter((o) => o !== k).flatMap((o) => [...T[o]]));
    console.log(`| ${NAMES[k]} | ${count[k]} | ${T[k].size} | ${[...T[k]].filter((x) => !others.has(x)).length} |`);
}
console.log("\n행 = 이 확장 작품 중 열 확장에도 있는 %\n\n| | " + K.map((k) => NAMES[k]).join(" | ") + " |\n|---|" + K.map(() => "---").join("|") + "|");
for (const a of K) console.log(`| ${NAMES[a]} | ` + K.map((b) => (a === b ? "-" : pct(a, b))).join(" | ") + " |");
