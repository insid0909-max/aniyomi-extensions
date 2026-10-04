// 확장 감시: 사이트 주소 자동 갱신(domains) / 확장 동작 점검(health)
// 사용: node monitor.js <config.json> <상태 폴더> <모드: all|domains|health>
// 결과는 실행 기록에만 남기고, 상태는 상태 폴더(state.json, status.json)에 저장한다.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadExtension, request } = require("./runtime");

const [configPath, stateDir, mode = "all"] = process.argv.slice(2);
const ROOT = process.env.REPO_ROOT || process.cwd();
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const statePath = path.join(stateDir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
state.domains = state.domains || {};
state.health = state.health || {};
state.prefs = state.prefs || {};
const summary = { changedFiles: [], domainChanges: [], notes: [] };
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// ---------- 기록 ----------
function notify(title, message) {
    console.log(`[알림] ${title} | ${message}`);
}

function withTimeout(promise, ms, label) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 시간 초과`)), ms))]);
}

// ---------- 1) 사이트 주소 감시 ----------
function decodeAny(buf) {
    const u = buf.toString("utf8");
    try {
        return u + "\n" + new TextDecoder("euc-kr").decode(buf);
    } catch (e) {
        return u;
    }
}

async function probeSite(site, origin) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
        const res = await fetch(origin + (site.probe || "/"), { headers: { "User-Agent": UA }, redirect: "follow", signal: ctrl.signal });
        const text = decodeAny(Buffer.from(await res.arrayBuffer()));
        const finalOrigin = (/^(https?:\/\/[^/]+)/.exec(res.url) || [null, origin])[1];
        const cf = res.headers.get("cf-mitigated") || (/cloudflare/i.test(res.headers.get("server") || "") && /challenge|Just a moment/i.test(text));
        const marker = new RegExp(site.marker, "i").test(text);
        return { status: res.status, finalOrigin, marker, blocked: !!cf && (res.status === 403 || res.status === 503 || res.status === 429) };
    } catch (e) {
        return { status: 0, error: e.name === "AbortError" ? "시간 초과" : e.message };
    } finally {
        clearTimeout(timer);
    }
}

function siteNumber(site, origin) {
    const m = new RegExp(site.pattern).exec(origin);
    return m ? parseInt(m[1], 10) : null;
}

function siteOrigin(site, n) {
    return site.format.replace("{n}", String(n).padStart(site.pad || 0, "0"));
}

function currentOrigin(site) {
    const text = fs.readFileSync(path.join(ROOT, site.currentFrom.file), "utf8");
    const m = new RegExp(site.currentFrom.regex).exec(text);
    if (!m) throw new Error(`${site.name}: 현재 주소를 ${site.currentFrom.file} 에서 찾지 못함`);
    return m[1];
}

async function checkDomains() {
    for (const site of config.sites || []) {
        let cur;
        try {
            cur = currentOrigin(site);
        } catch (e) {
            console.log(e.message);
            continue;
        }
        const r = await probeSite(site, cur);
        let verdict;
        let found = null;
        if (r.blocked) verdict = "blocked";
        else if (r.status === 200 && r.marker && r.finalOrigin !== cur && new RegExp(site.pattern).test(r.finalOrigin)) {
            verdict = "moved";
            found = r.finalOrigin;
        } else if (r.status >= 200 && r.status < 400 && r.marker) verdict = "alive";
        else verdict = "dead";
        console.log(`[주소] ${site.name} ${cur} → ${verdict} (HTTP ${r.status}${r.error ? " " + r.error : ""})`);

        if (verdict === "dead") {
            const n = siteNumber(site, cur) ?? 0;
            const [lo, hi] = site.range || [-3, 40];
            const cands = [];
            for (let i = Math.max(site.min ?? 1, n + lo); i <= n + hi; i++) if (i !== n) cands.push(siteOrigin(site, i));
            const hits = [];
            for (let i = 0; i < cands.length; i += 12) {
                const batch = await Promise.all(cands.slice(i, i + 12).map(async (c) => {
                    const p = await probeSite(site, c);
                    return p.status === 200 && p.marker && new RegExp(site.pattern).test(p.finalOrigin) ? p.finalOrigin : null;
                }));
                hits.push(...batch.filter((x) => x));
            }
            hits.sort((a, b) => (siteNumber(site, b) ?? 0) - (siteNumber(site, a) ?? 0));
            found = hits[0] || null;
            if (found) {
                const again = await probeSite(site, found);
                if (!(again.status === 200 && again.marker)) found = null;
            }
        }

        const prev = state.domains[site.name] || {};
        if (found && found !== cur) {
            const files = replaceOrigin(cur, found);
            summary.domainChanges.push({ name: site.name, from: cur, to: found, files });
            state.domains[site.name] = { origin: found, status: "alive", since: new Date().toISOString() };
            notify(`🔁 ${site.name} 주소 변경`, `${cur.replace("https://", "")} → ${found.replace("https://", "")}\n확장 기본 주소를 바꿔 다시 배포합니다.`, found, "arrows_counterclockwise");
        } else if (verdict === "dead") {
            if (prev.status !== "dead") {
                notify(`⚠️ ${site.name} 접속 불가`, `${cur.replace("https://", "")} 가 열리지 않고 새 주소도 찾지 못했습니다 (HTTP ${r.status}${r.error ? ", " + r.error : ""}).`, null, "warning");
            }
            state.domains[site.name] = { origin: cur, status: "dead", since: prev.status === "dead" ? prev.since : new Date().toISOString() };
        } else {
            if (prev.status === "dead") notify(`✅ ${site.name} 다시 열림`, cur.replace("https://", ""), cur, "white_check_mark");
            state.domains[site.name] = { origin: cur, status: verdict, since: prev.status === verdict ? prev.since : new Date().toISOString() };
        }
    }
}

/** 저장소 안 텍스트 파일에서 옛 주소를 새 주소로 바꾸고, 바뀐 망가요미 확장은 버전을 올림 */
function replaceOrigin(from, to) {
    const changed = [];
    for (const rel of config.replaceIn || []) {
        const file = path.join(ROOT, rel);
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, "utf8");
        if (!text.includes(from)) continue;
        fs.writeFileSync(file, text.split(from).join(to));
        changed.push(rel);
    }
    for (const rel of changed.filter((f) => f.endsWith(".js"))) bumpJsVersion(rel);
    for (const f of changed) if (!summary.changedFiles.includes(f)) summary.changedFiles.push(f);
    return changed;
}

function bumpVersion(v) {
    const p = String(v).split(".").map((x) => parseInt(x, 10) || 0);
    while (p.length < 3) p.push(0);
    p[2] += 1;
    return p.join(".");
}

function bumpJsVersion(rel) {
    const file = path.join(ROOT, rel);
    let text = fs.readFileSync(file, "utf8");
    const m = /"version":\s*"([\d.]+)"/.exec(text);
    if (!m) return;
    const next = bumpVersion(m[1]);
    text = text.replace(m[0], `"version": "${next}"`);
    fs.writeFileSync(file, text);
    // 색인 파일이 저장소에 따로 있으면(애니 저장소) 같이 올림
    for (const idxRel of config.indexFiles || []) {
        const idxFile = path.join(ROOT, idxRel);
        if (!fs.existsSync(idxFile)) continue;
        const idx = JSON.parse(fs.readFileSync(idxFile, "utf8"));
        let touched = false;
        for (const e of idx) {
            if (String(e.sourceCodeUrl || "").endsWith("/" + path.basename(rel))) {
                e.version = next;
                touched = true;
            }
        }
        if (touched) {
            fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2) + "\n");
            if (!summary.changedFiles.includes(idxRel)) summary.changedFiles.push(idxRel);
        }
    }
}

// ---------- 2) 확장 동작 점검 ----------
function prefsFor(name) {
    state.prefs[name] = state.prefs[name] || {};
    return state.prefs[name];
}

async function runHealth(item) {
    const { ext } = loadExtension(path.join(ROOT, item.file), prefsFor(item.name));
    const T = 120000;
    const popular = await withTimeout(ext.getPopular(1), T, "목록");
    const list = (popular && popular.list) || [];
    if (!list.length) {
        if (item.allowEmpty) return "목록 비어 있음(정상 범위)";
        throw new Error("목록: 작품 0개");
    }
    if (item.depth === "list") return `목록 ${list.length}개`;
    const first = list[0];
    const detail = await withTimeout(ext.getDetail(first.link), T, "상세");
    const eps = (detail && (detail.chapters || detail.episodes)) || [];
    if (!eps.length) throw new Error(`상세: 회차 0개 (${first.name})`);
    const st = { 0: "연재", 1: "완결" }[detail.status] || "상태 미확인";
    if (item.depth === "detail") return `목록 ${list.length}개, 회차 ${eps.length}개, ${st}`;
    const ep = eps[0];
    if (item.depth === "pages") {
        const pages = await withTimeout(ext.getPageList(ep.url), T, "이미지");
        if (!pages || !pages.length) throw new Error(`이미지 0개 (${first.name} ${ep.name})`);
        return `목록 ${list.length}개, 회차 ${eps.length}개, 이미지 ${pages.length}장, ${st}`;
    }
    const videos = await withTimeout(ext.getVideoList(ep.url), T, "영상");
    if (!videos || !videos.length) throw new Error(`영상 주소 0개 (${first.name} ${ep.name})`);
    return `목록 ${list.length}개, 회차 ${eps.length}개, 영상 ${videos.length}개, ${st}`;
}

async function checkHealth() {
    const report = [];
    for (const item of config.health || []) {
        let ok = true;
        let msg;
        try {
            msg = await runHealth(item);
        } catch (e) {
            ok = false;
            msg = String(e && e.message || e).substring(0, 200);
        }
        console.log(`[점검] ${item.name}: ${ok ? "정상" : "문제"} - ${msg}`);
        report.push(`${ok ? "✅" : "❌"} ${item.name}`);
        const prev = state.health[item.name];
        if (prev && prev.ok && !ok) notify(`❌ ${item.name} 고장 의심`, msg, null, "x");
        if (prev && !prev.ok && ok) notify(`✅ ${item.name} 정상으로 돌아옴`, msg, null, "white_check_mark");
        state.health[item.name] = { ok, msg, at: new Date().toISOString(), since: prev && prev.ok === ok ? prev.since : new Date().toISOString() };
    }
    if (!state.healthStarted) {
        state.healthStarted = new Date().toISOString();
        notify(`🩺 ${config.label} 확장 점검 시작`, report.join("\n"), null, "stethoscope");
    }
}

// ---------- 확장이 읽어 가는 상태 요약 (status.json) ----------
// 확장 필터 화면 맨 위에 "주소 · 점검 결과"를 보여 주는 데 쓰인다. key 는 config 의 sites/health 항목에 적은 값.
function writeStatus() {
    const items = {};
    for (const site of config.sites || []) {
        if (!site.key) continue;
        const d = state.domains[site.name];
        if (!d) continue;
        items[site.key] = Object.assign(items[site.key] || {}, { origin: d.origin, domain: d.status, domainSince: d.since });
    }
    for (const h of config.health || []) {
        if (!h.key) continue;
        const r = state.health[h.name];
        if (!r) continue;
        items[h.key] = Object.assign(items[h.key] || {}, { ok: r.ok, msg: r.msg, checkedAt: r.at });
    }
    const prevPath = path.join(stateDir, "status.json");
    const prev = fs.existsSync(prevPath) ? fs.readFileSync(prevPath, "utf8") : "";
    const next = JSON.stringify({ items }, null, 1) + "\n";
    if (prev !== next) fs.writeFileSync(prevPath, next);
}

(async () => {
    if (mode === "all" || mode === "domains") await checkDomains();
    if (mode === "all" || mode === "health") await checkHealth();
    writeStatus();
    if (mode === "all") state.lastRun = { mode, at: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");
    fs.writeFileSync(path.join(stateDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
    console.log("요약:", JSON.stringify(summary));
    // 시간 제한용 타이머가 남아 프로세스가 늦게 끝나지 않도록 바로 종료
    process.exit(0);
})().catch((e) => {
    console.error("오류", e);
    process.exit(1);
});
