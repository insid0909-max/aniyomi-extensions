// 빠른 주소 확인 (2026-11-13, 사용자 "진행" — 문제 생기면 사람이 복사하지 않아도 확장이 스스로 옮겨 가게)
// 30분마다 저장소 주소 목록(domains.json)의 주소를 두드려 보고,
//  ① 옛 주소가 같은 이름·더 큰 번호의 주소로 넘겨 주면(301·302…)
//  ② (config 의 guides 가 있으면) 안내 페이지에 같은 이름·더 큰 번호의 주소가 적혀 있으면
// 그 주소가 답할 때(200·403 등 — 해외에선 막힌 곳이 많아 화면까진 못 봄, 확장이 휴대폰에서 진짜 사이트인지 다시 확인함)
// domains.json 을 그 주소로 고치고 업데이트 내역에 한 줄 적는다. 옛 번호·다른 이름으로는 절대 안 바꿈.
// 사용: node quickdomains.js <domains.json> [감시 config.json] [changelog.json 업데이트내역.md changelog.js]
"use strict";
const fs = require("fs");
const path = require("path");

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const [domainsFile, configFile, logFile, mdFile, logJs] = process.argv.slice(2);

const plain = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "").toLowerCase();
// 같은 사이트 이름(숫자 뺀 가장 긴 이름 칸)이고 숫자들을 앞에서부터 비교해 a 가 b 보다 크면 true (확장·감시 작업과 같은 규칙)
function newer(a, b) {
    const brand = (h) => h.replace(/\d+/g, "").split(".").slice(0, -1).sort((x, y) => y.length - x.length)[0] || "";
    const nums = (h) => (h.match(/\d+/g) || []).map(Number);
    if (!a || !b || a === b || !brand(a) || brand(a) !== brand(b)) return false;
    const x = nums(a);
    const y = nums(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] > y[i];
    return x.length > y.length;
}

async function get(url, manual) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
        return await fetch(url, { redirect: manual ? "manual" : "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
    } catch (e) {
        return null;
    } finally {
        clearTimeout(t);
    }
}

// 서버가 답하는지 (해외에서 막힌 403·429·451 도 살아 있는 것으로 봄)
async function answers(host) {
    const r = await get("https://" + host + "/", true);
    return !!r && ((r.status >= 200 && r.status < 400) || [401, 403, 429, 451].includes(r.status));
}

(async () => {
    const data = JSON.parse(fs.readFileSync(domainsFile, "utf8"));
    const config = configFile && fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
    const changes = [];
    for (const [key, v] of Object.entries(data.domains || {})) {
        const cur = plain(v.baseUrl);
        if (!cur) continue;
        const cands = [];
        // ① 지금 주소가 넘겨 주는 곳
        const r = await get("https://" + cur + "/", true);
        if (r && r.status >= 300 && r.status < 400) {
            const to = plain(r.headers.get("location"));
            if (newer(to, cur)) cands.push({ host: to, why: "옛 주소가 넘겨 줌" });
        }
        // ② 안내 페이지에 적힌 주소
        for (const g of (config.guides || []).filter((x) => x.key === key)) {
            const gr = await get(g.url, false);
            if (!gr || gr.status !== 200) continue;
            const text = await gr.text();
            for (const h of new Set((text.match(new RegExp(g.regex, "gi")) || []).map(plain))) if (newer(h, cur)) cands.push({ host: h, why: "안내 페이지" });
        }
        cands.sort((a, b) => (newer(a.host, b.host) ? -1 : newer(b.host, a.host) ? 1 : 0));
        for (const c of cands) {
            if (!(await answers(c.host))) continue;
            const www = /^https?:\/\/www\./.test(v.baseUrl) ? "www." : "";
            data.domains[key] = Object.assign({}, v, { baseUrl: "https://" + www + c.host, updated: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) });
            changes.push({ key, from: cur, to: www + c.host, why: c.why });
            break;
        }
    }
    if (!changes.length) {
        console.log("주소 목록 그대로");
        return;
    }
    const indent = /\n( +)"/.exec(fs.readFileSync(domainsFile, "utf8"));
    fs.writeFileSync(domainsFile, JSON.stringify(data, null, indent ? indent[1].length : 2) + "\n");
    if (logFile && fs.existsSync(logFile) && logJs) {
        try {
            const { addNote, render } = require(path.resolve(logJs));
            const log = JSON.parse(fs.readFileSync(logFile, "utf8"));
            const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
            for (const c of changes) if (log.items && log.items[c.key]) addNote(log, c.key, day, `기본 주소 ${c.to} 로 자동 변경 (${c.why}, 30분 확인)`);
            fs.writeFileSync(logFile, JSON.stringify(log, null, 1) + "\n");
            if (mdFile) fs.writeFileSync(mdFile, render(log));
        } catch (e) {
            console.log("업데이트 내역 적기 실패:", e.message);
        }
    }
    for (const c of changes) console.log(`바꿈 ${c.key}: ${c.from} → ${c.to} (${c.why})`);
    console.log("CHANGED");
})();
