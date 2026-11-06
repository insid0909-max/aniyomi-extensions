// 받은 목록(tsv)들로 겹침 표 만들기
// 사용: node mangayomi/tools/compare/analyze.js <폴더>   (폴더 안 *.tsv → 요약표를 화면에 출력)
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const NAMES = { gogotv: "고고티비", tvchak: "티비착", kotbc: "코티비씨", ohli24: "애니24", aniwolf: "애니울프", anilife: "애니라이프", mimitv: "미미티비" };
// 제목 비교: 끝의 " (2026)"·" · 11.05" 표시와 띄어쓰기·기호를 빼고 비교
// 사이트마다 연도·영어 원제 붙이는 모양이 달라("월드워Z World War Z, 2013"·"주토피아 · 2016"·"관상 (2013)") → 끝의 연도를 빼고,
// 한글 제목이면 영어 글자도 뺀 뒤 비교 (2026-11-06 미미티비·고고티비 비교 때)
const norm = (t) => {
    let s = t.normalize("NFC").replace(/\s*·\s*\d\d\.\d\d\s*$/, "");
    for (let i = 0; i < 3; i++) s = s.replace(/[\s,.·(]*(?:19|20)\d{2}\)?\s*$/, "");
    if (/[가-힣]/.test(s)) s = s.replace(/[A-Za-z]+/g, "");
    return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
};
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
