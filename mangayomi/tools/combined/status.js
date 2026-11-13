// 확장 상태판 만들기 (2026-11-13, 사용자 "1번 진행")
// 애니·웹툰 저장소의 감시 결과(monitor-state/status.json·state.json)·주소 목록(domains.json)·업데이트 내역(changelog.json)·
// 망가요미 목록(버전)을 모아 한 장짜리 상태판(Markdown)을 만든다. 휴대폰에서 github.com 주소로 열어 봄.
// 사용: node status.js <애니 저장소 경로> <출력 파일> [예전 상태판 파일]
"use strict";
const fs = require("fs");
const path = require("path");

const RAW = "https://raw.githubusercontent.com/insid0909-max/";
// 지금 쓰는 확장 (보관함에 넣은 것은 빼고). js: 망가요미 파일 이름, kt: 애니요미 있음, abroad: 해외에서 막혀 감시 작업이 확인 못 함
const ANIME = [
    { key: "gogotv", name: "고고티비", js: "gogotv.js", kt: true },
    { key: "tvchak", name: "티비착", js: "tvchak.js", kt: true, abroad: true },
    { key: "hoohootv", name: "후후티비", kt: true, abroad: true },
    { key: "tvwiki", name: "티비위키", js: "tvwiki.js", kt: true, abroad: true },
    { key: "mimitv", name: "미미티비", js: "mimitv.js", kt: true },
    { key: "kotbc", name: "코티비씨", js: "kotbc.js", abroad: true },
    { key: "anilife", name: "애니라이프", js: "anilife.js", kt: true, abroad: true },
    { key: "ohli24", name: "애니24", js: "ohli24.js", kt: true, addr: "www.ohli24.net" },
    { key: "aniwolf", name: "애니울프", js: "aniwolf.js", kt: true, addr: "aniwolf.com" },
    { key: "aniweek", name: "애니위크", js: "aniweek.js", kt: true },
    { key: "aniya24", name: "애니야24", kt: true, abroad: true, addr: "www.aniya24.com" },
    { key: "livesports1", name: "실시간스포츠1", js: "livesports1.js", kt: true },
    { key: "livesports2", name: "실시간스포츠2", js: "livesports2.js", kt: true },
    { key: "samsungtvplus", name: "삼성 TV 플러스", js: "samsungtvplus.js", kt: true, addr: "삼성 공식 채널" },
];
const WEBTOON = [
    { key: "wolftoon", name: "늑대닷컴", js: "wolftoon.js", kt: true },
    { key: "blacktoon", name: "블랙툰", js: "blacktoon.js", kt: true },
    { key: "goraetoon", name: "고래툰", js: "goraetoon.js", kt: true },
    { key: "goodtoon", name: "굿툰", js: "goodtoon.js", kt: true },
    { key: "toonkor", name: "툰코", js: "toonkor.js", kt: true },
    { key: "mtoon", name: "머니툰", js: "mtoon.js", kt: true },
    { key: "toon11", name: "11툰", js: "toon11.js", kt: true },
    { key: "newxtoon", name: "뉴엑스툰", js: "newxtoon.js", kt: true, abroad: true },
    { key: "naverwebtoon", name: "네이버웹툰", js: "naverwebtoon.js", kt: true, abroad: true, addr: "comic.naver.com" },
    { key: "bookkor", name: "북코 소설", js: "bookkor.js", kt: true },
    { key: "tokinovel", name: "토끼 소설", js: "tokinovel.js", kt: true, abroad: true },
];

async function getJson(url) {
    try {
        const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { headers: { "Cache-Control": "no-cache" } });
        return r.ok ? await r.json() : null;
    } catch (e) {
        return null;
    }
}

const kst = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t + 9 * 3600000);
    const z = (n) => String(n).padStart(2, "0");
    return `${z(d.getUTCMonth() + 1)}.${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
};
const host = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const cell = (s) => String(s || "").replace(/\|/g, "／").replace(/\s+/g, " ").trim();
const short = (s, n) => (cell(s).length > n ? cell(s).slice(0, n - 1) + "…" : cell(s));

function versionOf(list, file) {
    if (!file || !Array.isArray(list)) return "";
    const e = list.find((x) => String(x.pkgPath || x.sourceCodeUrl || "").split("?")[0].split("/").pop() === file);
    return e ? e.version : "";
}

function rows(sites, src) {
    const out = [];
    let bad = 0;
    for (const s of sites) {
        const st = ((src.status || {}).items || {})[s.key] || {};
        const listed = (((src.domains || {}).domains || {})[s.key] || {}).baseUrl || "";
        const addr = host(listed || st.origin) || s.addr || "—";
        let check;
        if (st.domain === "dead" && !s.abroad) {
            check = `❌ 주소 끊김 (${kst(st.domainSince)}부터)`;
            bad++;
        } else if (st.ok === true) check = `✅ 정상 · ${kst(st.checkedAt)}`;
        else if (st.ok === false && !s.abroad) {
            check = `❌ 문제 · ${kst(st.checkedAt)} · ${short(st.msg, 40)}`;
            bad++;
        } else if (s.abroad) check = "🌐 해외에서 막혀 확인 못 함";
        else check = "— 점검 안 함";
        const note = (((src.changelog || {}).items || {})[s.key] || [])[0];
        const last = note ? `${String(note.d).slice(5).replace("-", ".")} ${short(String(note.t).replace(/^(망가요미|애니요미):\s*/, ""), 46)}` : "";
        const ver = [versionOf(src.index, s.js) && `망가요미 ${versionOf(src.index, s.js)}`, s.kt && "애니요미"].filter(Boolean).join(" · ") || (s.js ? "망가요미" : "");
        out.push(`| ${cell(s.name)} | ${cell(addr)} | ${cell(check)} | ${cell(ver)} | ${cell(last)} |`);
    }
    return { text: out.join("\n"), bad };
}

function runLine(label, state) {
    const at = state && state.lastRun && state.lastRun.at;
    if (!at) return `- ${label} 감시 작업: 기록 없음`;
    const hours = (Date.now() - Date.parse(at)) / 3600000;
    return hours > 36
        ? `- ⚠️ ${label} 감시 작업이 ${Math.floor(hours / 24)}일째 멈춰 있어요 (마지막 ${kst(at)}) — GitHub Actions 가 꺼졌을 수 있어요`
        : `- ${label} 감시 작업 마지막 실행: ${kst(at)}`;
}

(async () => {
    const [root, outFile] = process.argv.slice(2);
    const read = (f) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
        } catch (e) {
            return null;
        }
    };
    const A = RAW + "aniyomi-extensions/";
    const W = RAW + "aniyomi-manga-extensions/";
    const [aStatus, aState, wStatus, wState, wDomains, wLog, wIndex, wNovel] = await Promise.all([
        getJson(A + "monitor-state/status.json"),
        getJson(A + "monitor-state/state.json"),
        getJson(W + "monitor-state/status.json"),
        getJson(W + "monitor-state/state.json"),
        getJson(W + "main/domains.json"),
        getJson(W + "main/changelog.json"),
        getJson(W + "gh-pages/mangayomi/index.json"),
        getJson(W + "gh-pages/mangayomi/novel_index.json"),
    ]);
    const anime = rows(ANIME, { status: aStatus, domains: read("domains.json"), changelog: read("changelog.json"), index: read("mangayomi/anime_index.json") });
    const webtoon = rows(WEBTOON, { status: wStatus, domains: wDomains, changelog: wLog, index: [...(wIndex || []), ...(wNovel || [])] });
    const bad = anime.bad + webtoon.bad;
    const head = "| 확장 | 지금 주소 | 점검 (해외 감시 작업) | 버전 | 마지막 업데이트 |\n|---|---|---|---|---|";
    const md = `# 확장 상태판

${bad ? `**❌ 문제 ${bad}곳** — 아래 ❌ 줄을 확인하세요.` : "**✅ 감시 작업이 확인한 확장은 모두 정상이에요.**"}

- 만든 시각: ${kst(new Date().toISOString())} (30분마다 확인, 내용이 바뀔 때만 새로 씀)
${runLine("애니", aState)}
${runLine("웹툰", wState)}
- 🌐 표시는 해외(GitHub)에서 막혀 감시 작업이 못 여는 사이트예요. 휴대폰에서 안 되면 필터 맨 위 📡·🔎 줄을 찍어 보내 주세요.

## 애니·드라마·스포츠

${head}
${anime.text}

## 웹툰·소설

${head}
${webtoon.text}

---
이 페이지는 자동 작업(\`.github/workflows/combined-index.yml\`, \`mangayomi/tools/combined/status.js\`)이 만듭니다. 점검은 하루 한 번 해외 서버(GitHub)에서 목록·회차를 열어 봅니다.
`;
    // 시각 줄만 다르면 예전 파일 그대로 (30분마다 쓸데없는 기록이 쌓이지 않게)
    const prevFile = process.argv[4];
    const strip = (t) => String(t).replace(/^- 만든 시각:.*$/m, "");
    if (prevFile && fs.existsSync(prevFile) && strip(fs.readFileSync(prevFile, "utf8")) === strip(md)) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.copyFileSync(prevFile, outFile);
        console.log("바뀐 것 없음 (시각만 다름)");
        return;
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, md);
    console.log(md);
})();
