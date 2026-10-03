// 확장 감시: 사이트 주소 자동 갱신(domains) / 확장 동작 점검(health) / 새 회차 알림(watch)
// 사용: node monitor.js <config.json> <상태 폴더> <모드: all|watch|domains|health>
// 결과 알림은 ntfy 로 보내고, 상태는 상태 폴더(state.json, watchlist.json)에 저장한다.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadExtension, request } = require("./runtime");

const [configPath, stateDir, mode = "all"] = process.argv.slice(2);
const ROOT = process.env.REPO_ROOT || process.cwd();
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const statePath = path.join(stateDir, "state.json");
const watchPath = path.join(stateDir, "watchlist.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
state.domains = state.domains || {};
state.health = state.health || {};
state.watch = state.watch || {};
state.prefs = state.prefs || {};
const summary = { changedFiles: [], domainChanges: [], notes: [] };
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// ---------- 알림 ----------
async function notify(title, message, click, tag) {
    console.log(`[알림] ${title} | ${message}`);
    if (!config.ntfy || process.env.DRY_RUN) return;
    const body = { topic: config.ntfy, title, message, tags: [tag || "bell"] };
    if (click) body.click = click;
    try {
        await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
        console.log("알림 전송 실패:", e.message);
    }
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
            await notify(`🔁 ${site.name} 주소 변경`, `${cur.replace("https://", "")} → ${found.replace("https://", "")}\n확장 기본 주소를 바꿔 다시 배포합니다.`, found, "arrows_counterclockwise");
        } else if (verdict === "dead") {
            if (prev.status !== "dead") {
                await notify(`⚠️ ${site.name} 접속 불가`, `${cur.replace("https://", "")} 가 열리지 않고 새 주소도 찾지 못했습니다 (HTTP ${r.status}${r.error ? ", " + r.error : ""}).`, null, "warning");
            }
            state.domains[site.name] = { origin: cur, status: "dead", since: prev.status === "dead" ? prev.since : new Date().toISOString() };
        } else {
            if (prev.status === "dead") await notify(`✅ ${site.name} 다시 열림`, cur.replace("https://", ""), cur, "white_check_mark");
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
        if (prev && prev.ok && !ok) await notify(`❌ ${item.name} 고장 의심`, msg, null, "x");
        if (prev && !prev.ok && ok) await notify(`✅ ${item.name} 정상으로 돌아옴`, msg, null, "white_check_mark");
        state.health[item.name] = { ok, msg, at: new Date().toISOString(), since: prev && prev.ok === ok ? prev.since : new Date().toISOString() };
    }
    if (!state.healthStarted) {
        state.healthStarted = new Date().toISOString();
        await notify(`🩺 ${config.label} 확장 점검 시작`, report.join("\n"), null, "stethoscope");
    }
}

// ---------- 3) 새 회차 알림 ----------
function normTitle(s) {
    return String(s || "").replace(/\s+/g, "").toLowerCase();
}

async function checkWatch() {
    const list = fs.existsSync(watchPath) ? JSON.parse(fs.readFileSync(watchPath, "utf8")) : [];
    let dirty = false;
    for (const w of list) {
        const file = (config.watchSources || {})[w.source];
        if (!file) {
            console.log(`[회차] 알 수 없는 소스: ${w.source}`);
            continue;
        }
        const key = `${w.source}|${w.url || w.title}`;
        try {
            const { ext, source } = loadExtension(path.join(ROOT, file), prefsFor(w.source));
            if (!w.url) {
                const res = await withTimeout(ext.search(w.title, 1, ext.getFilterList ? ext.getFilterList() : []), 60000, "검색");
                const items = (res && res.list) || [];
                const hit = items.find((x) => normTitle(x.name) === normTitle(w.title)) || items.find((x) => normTitle(x.name).includes(normTitle(w.title)));
                if (!hit) throw new Error(`검색 결과에서 "${w.title}" 를 찾지 못함`);
                w.url = hit.link;
                w.name = hit.name;
                dirty = true;
            }
            const detail = await withTimeout(ext.getDetail(w.url), 120000, "상세");
            const eps = (detail.chapters || detail.episodes || []).filter((c) => c && c.url);
            const known = state.watch[key];
            const urls = eps.map((c) => c.url);
            if (!known) {
                state.watch[key] = urls.slice(0, 500);
                console.log(`[회차] ${w.name || w.title}: 처음 등록 (${eps.length}화)`);
                continue;
            }
            const fresh = eps.filter((c) => !known.includes(c.url));
            console.log(`[회차] ${w.name || w.title}: 새 회차 ${fresh.length}개`);
            const base = (prefsFor(w.source).auto_domain || source.baseUrl).replace(/\/+$/, "");
            for (const c of fresh.slice(0, 5).reverse()) {
                const link = /^https?:\/\//.test(c.url) ? c.url : base + c.url;
                await notify(`📢 ${detail.name || w.name || w.title}`, `${c.name} 업데이트 (${source.name})`, link, "books");
            }
            if (fresh.length > 5) await notify(`📢 ${detail.name || w.name}`, `새 회차 ${fresh.length}개가 올라왔습니다`, null, "books");
            state.watch[key] = urls.concat(known.filter((u) => !urls.includes(u))).slice(0, 500);
        } catch (e) {
            console.log(`[회차] ${w.title || w.url}: 실패 - ${e.message}`);
        }
    }
    if (dirty) fs.writeFileSync(watchPath, JSON.stringify(list, null, 2) + "\n");
}

// ---------- 4) 실시간스포츠 경기 알림 ----------
// teams.json(상태 브랜치)에 적은 팀 이름이 들어간 경기가 곧 시작하면(또는 이미 방송 중이면) 한 번 알림
async function checkSports() {
    const sp = config.sports;
    if (!sp) return;
    const teamsPath = path.join(stateDir, "teams.json");
    const teams = fs.existsSync(teamsPath) ? JSON.parse(fs.readFileSync(teamsPath, "utf8")) : [];
    if (!teams.length) return;
    const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
    const records = [];
    for (const col of ["view_bw_live_on", "view_bw_live_soon"]) {
        try {
            const res = await request("GET", `${sp.api}/api/collections/${col}/records?perPage=500`, { "User-Agent": UA });
            const items = (JSON.parse(res.body).items || []);
            for (const it of items) records.push(Object.assign({ live: col === "view_bw_live_on" || it.is_live === 1 }, it));
        } catch (e) {
            console.log(`[경기] ${col} 읽기 실패: ${e.message}`);
        }
    }
    state.sports = state.sports || [];
    const now = Date.now();
    const windowMs = (sp.notifyBeforeMinutes || 75) * 60000;
    for (const r of records) {
        const home = r.team_name_home || "";
        const away = r.team_name_away || "";
        // "=이름" 은 정확히 같은 팀만 (괄호 속 U23·(N)·여자 표기는 무시) → 국가대표용. 그 외는 이름 일부만 맞아도 됨
        const bare = (s) => norm(String(s || "").replace(/\([^)]*\)/g, ""));
        const match = (name, t) => t.startsWith("=") ? bare(name) === norm(t.substring(1)) : norm(name).includes(norm(t));
        const hit0 = teams.find((t) => match(home, t) || match(away, t));
        const hit = hit0 && hit0.replace(/^=/, "");
        if (!hit || state.sports.includes(r.id)) continue;
        // time_gmt9 는 한국시간 값에 Z 가 붙어 있음 → UTC 로 9시간 빼서 계산
        const kst = String(r.time_gmt9 || "").replace(/Z$/, "").replace(" ", "T");
        const start = kst ? Date.parse(kst + "+09:00") : NaN;
        const soon = !isNaN(start) && start - now <= windowMs && start - now > -3 * 3600000;
        if (!r.live && !soon) continue;
        const hhmm = isNaN(start) ? "" : new Date(start + 9 * 3600000).toISOString().substring(11, 16);
        const title = r.live ? `🔴 방송 중: ${home} vs ${away}` : `⏰ 곧 시작 ${hhmm}: ${home} vs ${away}`;
        await notify(title, `${r.league_name || r.sports || ""} · 관심 팀 "${hit}" (실시간스포츠2)`, sp.site, "soccer");
        state.sports.push(r.id);
    }
    state.sports = state.sports.slice(-300);
    console.log(`[경기] 관심 팀 ${teams.length}개, 경기 ${records.length}개 확인`);
}

(async () => {
    if (mode === "test") {
        await notify("🔔 테스트 알림", "ntfy 구독이 정상입니다. 앞으로 주소 변경·고장·새 회차 알림이 이곳으로 옵니다.", "https://wfwf510.com/", "white_check_mark");
        process.exit(0);
    }
    if (mode === "all" || mode === "domains") await checkDomains();
    if (mode === "all" || mode === "health") await checkHealth();
    if (mode === "all" || mode === "watch") await checkWatch();
    if (mode === "all" || mode === "watch" || mode === "sports") await checkSports();
    // 하루 한 번(all)만 시각을 남겨, 매시간 상태 커밋이 생기지 않게 함
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
