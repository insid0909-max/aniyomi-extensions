// 망가요미 JS 확장을 Node 에서 실행하기 위한 최소 런타임 (Client / Document / SharedPreferences / unpackJs)
// 망가요미(Dart http)처럼 응답 헤더에 charset=utf-8 이 없으면 본문을 Latin-1 로 넘긴다.
"use strict";
const fs = require("fs");
const { parseHTML } = require("linkedom");

const TIMEOUT_MS = 25000;

class El {
    constructor(n) { this.n = n; }
    get text() { return this.n.textContent || ""; }
    get className() { return this.n.className || ""; }
    get outerHtml() { return this.n.outerHTML || ""; }
    get innerHtml() { return this.n.innerHTML || ""; }
    attr(a) { return this.n.getAttribute ? (this.n.getAttribute(a) ?? "") : ""; }
    selectFirst(s) { const r = this.n.querySelector(s); return r ? new El(r) : null; }
    select(s) { return [...this.n.querySelectorAll(s)].map((x) => new El(x)); }
}

class Document extends El {
    constructor(html) { super(parseHTML(String(html || "")).document); }
}

function decodeBody(buf, contentType) {
    const m = /charset=([\w-]+)/i.exec(contentType || "");
    const cs = m ? m[1].toLowerCase() : "";
    if (cs === "utf-8" || cs === "utf8") return buf.toString("utf8");
    return buf.toString("latin1");
}

async function request(method, url, headers, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const h = Object.assign({}, headers || {});
        let payload;
        if (body !== undefined && body !== null) {
            payload = typeof body === "string" ? body : JSON.stringify(body);
        }
        const res = await fetch(url, { method, headers: h, body: payload, redirect: "follow", signal: ctrl.signal });
        const buf = Buffer.from(await res.arrayBuffer());
        const headersObj = {};
        res.headers.forEach((v, k) => { headersObj[k] = v; });
        return { statusCode: res.status, body: decodeBody(buf, res.headers.get("content-type")), headers: headersObj, url: res.url };
    } finally {
        clearTimeout(timer);
    }
}

class Client {
    async get(url, headers) { return request("GET", url, headers); }
    async post(url, headers, body) { return request("POST", url, headers, body); }
}

// p,a,c,k,e,d 압축 스크립트 풀기
function unpackJs(packed) {
    const m = /}\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/s.exec(packed);
    if (!m) return packed;
    let [, p, a, c, k] = m;
    a = parseInt(a, 10) || 62;
    c = parseInt(c, 10);
    k = k.split("|");
    const enc = (n) => (n < a ? "" : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    while (c--) if (k[c]) p = p.replace(new RegExp("\\b" + enc(c) + "\\b", "g"), k[c]);
    return p;
}

/** 확장 파일을 불러와 인스턴스를 만든다. prefs 는 확장별 설정 저장소(객체) */
function loadExtension(file, prefs) {
    const code = fs.readFileSync(file, "utf8");
    const store = prefs || {};
    const sandbox = {
        Client, Document, unpackJs, console,
        SharedPreferences: class {
            get(k) { return store[k]; }
            getString(k, d) { return store[k] ?? d; }
            setString(k, v) { store[k] = v; }
        },
    };
    let source = null;
    sandbox.MProvider = class { get source() { return source; } };
    const names = Object.keys(sandbox);
    const fn = new Function(...names, code + "\nreturn { DefaultExtension, sources: mangayomiSources };");
    const out = fn(...names.map((n) => sandbox[n]));
    source = out.sources[0];
    return { ext: new out.DefaultExtension(), source, prefs: store };
}

module.exports = { loadExtension, request, Document };
