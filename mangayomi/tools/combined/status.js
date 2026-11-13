// 확장 상태판 만들기 (2026-11-13, 사용자 "1번 진행")
// 애니·웹툰 저장소의 감시 결과(monitor-state/status.json·state.json)·주소 목록(domains.json)·업데이트 내역(changelog.json)·
// 망가요미 목록(버전)을 모아 한 장짜리 상태판(Markdown)을 만든다. 휴대폰에서 github.com 주소로 열어 봄.
// 사용: node status.js <애니 저장소 경로> <출력 파일> [예전 상태판 파일] [예전 status.json] — 같은 폴더에 status.json 도 씀
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

// 주소를 어디서 확인하는지 (감시 작업 설정의 안내 페이지 → 사람이 읽기 쉬운 이름)
function sourceName(url) {
    let h = "";
    try {
        h = require("url").domainToUnicode(new URL(url).hostname);
    } catch (e) {
        return "";
    }
    if (/telegra\.ph$/.test(h)) return "텔레그래프 안내 글";
    if (/^t\.me$/.test(h)) return "텔레그램 " + (String(url).split("/").filter(Boolean).pop() || "");
    return h;
}
function sourceOf(key, cfg) {
    const g = ((cfg && cfg.guides) || []).filter((x) => x.key === key).map((x) => sourceName(x.url)).filter(Boolean);
    const site = ((cfg && cfg.sites) || []).find((x) => x.key === key);
    if (site && site.guide) g.unshift(sourceName(site.guide));
    const uniq = [...new Set(g.filter(Boolean))];
    if (uniq.length) return "안내: " + uniq.slice(0, 2).join(" · ");
    if (site) return "감시 작업 번호 확인";
    return "";
}

function rows(sites, src) {
    const out = [];
    const items = [];
    let bad = 0;
    for (const s of sites) {
        const st = ((src.status || {}).items || {})[s.key] || {};
        const listed = (((src.domains || {}).domains || {})[s.key] || {}).baseUrl || "";
        const listedAt = (((src.domains || {}).domains || {})[s.key] || {}).updated || "";
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
        const state = check.startsWith("❌") ? "bad" : check.startsWith("✅") ? "ok" : s.abroad ? "abroad" : "none";
        items.push({
            key: s.key,
            name: s.name,
            addr,
            link: /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(addr) ? "https://" + addr : "",
            state,
            checkedAt: st.checkedAt || "",
            msg: state === "bad" ? cell(st.msg || (st.domain === "dead" ? "주소 끊김" : "")) : cell(st.msg || ""),
            since: st.domain === "dead" ? st.domainSince || "" : "",
            js: versionOf(src.index, s.js) || "",
            kt: !!s.kt,
            source: sourceOf(s.key, src.config),
            addrSince: (st.domain === "alive" && st.domainSince) || listedAt,
            note: note ? { d: note.d, t: cell(String(note.t).replace(/^(망가요미|애니요미):\s*/, "")) } : null,
        });
    }
    return { text: out.join("\n"), bad, items };
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
    const [aStatus, aState, wStatus, wState, wDomains, wLog, wIndex, wNovel, wConfig] = await Promise.all([
        getJson(A + "monitor-state/status.json"),
        getJson(A + "monitor-state/state.json"),
        getJson(W + "monitor-state/status.json"),
        getJson(W + "monitor-state/state.json"),
        getJson(W + "main/domains.json"),
        getJson(W + "main/changelog.json"),
        getJson(W + "gh-pages/mangayomi/index.json"),
        getJson(W + "gh-pages/mangayomi/novel_index.json"),
        getJson(W + "main/monitor/config.json"),
    ]);
    const anime = rows(ANIME, { status: aStatus, domains: read("domains.json"), changelog: read("changelog.json"), index: read("mangayomi/anime_index.json"), config: read("mangayomi/tools/monitor/config.json") });
    const webtoon = rows(WEBTOON, { status: wStatus, domains: wDomains, changelog: wLog, index: [...(wIndex || []), ...(wNovel || [])], config: wConfig });
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
    // 앱 모양 상태판(GitHub Pages status/)이 읽는 자료
    const runOf = (st) => (st && st.lastRun && st.lastRun.at) || "";
    const data = {
        generatedAt: new Date().toISOString(),
        runs: { anime: runOf(aState), webtoon: runOf(wState) },
        groups: [
            { id: "anime", title: "애니·드라마·스포츠", items: anime.items },
            { id: "webtoon", title: "웹툰·소설", items: webtoon.items },
        ],
    };
    const jsonFile = outFile.replace(/[^/\\]+$/, "status.json");
    const prevJson = process.argv[5];
    const stripJ = (o) => JSON.stringify(Object.assign({}, o, { generatedAt: "" }));
    let keep = false;
    try {
        keep = prevJson && fs.existsSync(prevJson) && stripJ(JSON.parse(fs.readFileSync(prevJson, "utf8"))) === stripJ(data);
    } catch (e) {
        keep = false;
    }
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    if (keep) fs.copyFileSync(prevJson, jsonFile);
    else fs.writeFileSync(jsonFile, JSON.stringify(data, null, 1) + "\n");
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
