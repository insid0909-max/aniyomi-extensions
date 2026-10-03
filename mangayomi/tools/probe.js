// 망가요미 JS 확장을 실제 네트워크로 돌려 보며, 지나간 페이지의 본문을 기록하는 점검용 스크립트
// 사용: node probe.js <확장 파일> [회차 주소]
const fs = require("fs");
const path = require("path");
const { parseHTML } = require("linkedom");

const OUT = process.env.PROBE_OUT || "probe-out";
fs.mkdirSync(OUT, { recursive: true });
let seq = 0;

class El {
    constructor(n) { this.n = n; }
    get text() { return this.n.textContent; }
    attr(a) { return this.n.getAttribute(a) ?? ""; }
    selectFirst(s) { const r = this.n.querySelector(s); return r ? new El(r) : null; }
    select(s) { return [...this.n.querySelectorAll(s)].map((x) => new El(x)); }
}
global.Document = class extends El { constructor(h) { super(parseHTML(h).document); } };
global.MProvider = class { get source() { return {}; } };
global.SharedPreferences = class { get() { return ""; } setString() {} };
global.unpackJs = (s) => s;

async function request(method, url, headers, body) {
    const res = await fetch(url, { method, headers: headers || {}, body, redirect: "follow" });
    const text = await res.text();
    const n = String(++seq).padStart(2, "0");
    const name = `${n}_${url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").substring(0, 80)}.txt`;
    fs.writeFileSync(path.join(OUT, name), `${method} ${url}\n최종 주소: ${res.url}\n상태: ${res.status}\n` +
        `요청 헤더: ${JSON.stringify(headers)}\n\n${text}`);
    console.log(`[${n}] ${res.status} ${url.substring(0, 140)} (${text.length}자)`);
    return { statusCode: res.status, body: text, headers: Object.fromEntries(res.headers) };
}
global.Client = class {
    async get(url, headers) { return request("GET", url, headers); }
    async post(url, headers, body) { return request("POST", url, headers, typeof body === "string" ? body : JSON.stringify(body)); }
};

// fetch 모드: node probe.js fetch "주소1 주소2 ..." → 각 주소의 본문을 문자셋(euc-kr 등)에 맞춰 저장
async function fetchMode(urls) {
    for (const url of urls.split(/\s+/).filter((u) => u)) {
        try {
            const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36" }, redirect: "follow" });
            const buf = Buffer.from(await res.arrayBuffer());
            const head = buf.toString("latin1");
            const cs = (/charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") || "") || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [null, "utf-8"])[1];
            const text = new TextDecoder(cs.toLowerCase()).decode(buf);
            const n = String(++seq).padStart(2, "0");
            const name = `${n}_${url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").substring(0, 80)}.txt`;
            fs.writeFileSync(path.join(OUT, name), `GET ${url}\n최종 주소: ${res.url}\n상태: ${res.status}\n문자셋: ${cs}\n\n${text}`);
            console.log(`[${n}] ${res.status} ${cs} ${url} (${text.length}자)`);
        } catch (e) {
            console.log(`실패 ${url}: ${e.message}`);
        }
    }
}

(async () => {
    if (process.argv[2] === "fetch") return fetchMode(process.argv[3] || "");
    const file = process.argv[2];
    const src = fs.readFileSync(file, "utf8") + "\nmodule.exports=DefaultExtension;";
    const m = { exports: {} };
    new Function("module", "require", src)(m, require);
    const ext = new m.exports();

    let episode = process.argv[3];
    if (!episode) {
        const list = await ext.getPopular(1);
        const first = list.list[0];
        console.log("첫 작품:", first.name, first.link);
        const detail = await ext.getDetail(first.link);
        episode = detail.episodes[0].url;
        console.log("첫 회차:", detail.episodes[0].name, episode);
    }
    try {
        console.log("결과:", JSON.stringify(await ext.getVideoList(episode), null, 1));
    } catch (e) {
        console.log("실패:", e.message);
    }
})().catch((e) => { console.error("오류", e); process.exit(1); });
