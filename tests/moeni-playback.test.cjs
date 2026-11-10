const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../js/moeni.js"), "utf8");
const sandbox = { MProvider: class {}, console, setTimeout, clearTimeout, Client: class {} };
vm.createContext(sandbox);
vm.runInContext(source + "\nglobalThis.api = { moeniInspectPlaylist, moeniResolveUri, moeniValidatePlayback, moeniSafeUrl, moeniCapturePage, moeniRegisterInline, DefaultExtension };", sandbox);
const api = sandbox.api;
const base = "https://video.example.test/hls/show/master.m3u8?token=valid";
const playlist = (durations = [6, 6], tail = "#EXT-X-ENDLIST") =>
    "#EXTM3U\n#EXT-X-TARGETDURATION:6\n" +
    durations.map((d, i) => `#EXTINF:${d},\nseg-${i}.ts?sig=s${i}\n`).join("") + tail;
const mockClient = (map) => {
    const calls = [];
    return {
        calls,
        async get(url, headers) {
            calls.push({ url, headers });
            if (!map[url]) throw new Error("Unexpected URL " + url);
            return map[url];
        },
    };
};
const response = (body, statusCode = 200) => ({ body, statusCode });
const rejectsCode = (fn, code) => assert.rejects(fn, (e) => e.code === code);

test("accept a finite VOD media playlist", () => {
    const r = api.moeniInspectPlaylist(playlist(), base);
    assert.equal(r.type, "media");
    assert.equal(r.duration, 12);
    assert.equal(r.segmentCount, 2);
});
test("accept BOM and CRLF", () => assert.equal(api.moeniInspectPlaylist("\uFEFF" + playlist().replace(/\n/g, "\r\n"), base).duration, 12));
for (const [name, body] of [["binary TS", "G@\0binary"], ["deny JSON", '{"deny":true}'], ["HTML", "<html>Denied</html>"]]) {
    test("reject " + name, () => assert.throws(() => api.moeniInspectPlaylist(body, base), (e) => e.code === "NOT_HLS"));
}
test("reject a fake EXTM3U prefix", () => assert.throws(() => api.moeniInspectPlaylist("#EXTM3Uevil\n" + playlist(), base)));
test("reject a 2-second playlist", () => assert.throws(() => api.moeniInspectPlaylist(playlist([2]), base), (e) => e.code === "SHORT"));
test("reject an unfinished VOD", () => assert.throws(() => api.moeniInspectPlaylist(playlist([6, 6], ""), base), (e) => e.code === "INCOMPLETE"));
test("reject missing target duration", () => assert.throws(() => api.moeniInspectPlaylist(playlist().replace("#EXT-X-TARGETDURATION:6\n", ""), base)));
test("reject missing final segment URI", () => assert.throws(() => api.moeniInspectPlaylist(playlist() + "\n#EXTINF:6,", base), (e) => e.code === "MANIFEST"));
test("reject missing intermediate segment URI", () => assert.throws(() => api.moeniInspectPlaylist(playlist().replace("seg-0.ts?sig=s0", ""), base)));
test("reject invalid duration", () => assert.throws(() => api.moeniInspectPlaylist(playlist().replace("#EXTINF:6,", "#EXTINF:NaN,"), base)));
test("reject I-frame only playlist", () => assert.throws(() => api.moeniInspectPlaylist(playlist() + "\n#EXT-X-I-FRAMES-ONLY", base), (e) => e.code === "TRICK_PLAY"));
test("reject a segment exceeding target duration", () => assert.throws(() => api.moeniInspectPlaylist(playlist([7, 7]), base), (e) => e.code === "MANIFEST"));
test("do not silently discard external audio renditions", () => {
    const body = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"\nvideo.m3u8';
    assert.throws(() => api.moeniInspectPlaylist(body, base), (e) => e.code === "RENDITION");
});
test("parse a master variant", () => {
    const r = api.moeniInspectPlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n../720/index.m3u8?sig=own", base);
    assert.equal(r.variants[0], "https://video.example.test/hls/720/index.m3u8?sig=own");
});
test("resolve relative URI without copying master token", () => assert.equal(api.moeniResolveUri(base, "child.m3u8"), "https://video.example.test/hls/show/child.m3u8"));
test("resolve root-relative URI", () => assert.equal(api.moeniResolveUri(base, "/720.m3u8"), "https://video.example.test/720.m3u8"));
test("resolve scheme-relative URI", () => assert.equal(api.moeniResolveUri(base, "//cdn.example.test/a.m3u8"), "https://cdn.example.test/a.m3u8"));
test("resolve query-only URI", () => assert.equal(api.moeniResolveUri(base, "?quality=720"), "https://video.example.test/hls/show/master.m3u8?quality=720"));
test("reject dangerous URI scheme", () => assert.throws(() => api.moeniResolveUri(base, "javascript:bad()"), (e) => e.code === "URI"));
test("redact query, fragment and userinfo from stored URL", () => assert.equal(api.moeniSafeUrl("https://u:p@host.test/a?token=secret#private"), "https://host.test/a"));
test("reject .ts even when disguised by fragment", async () => {
    const client = mockClient({});
    await rejectsCode(() => api.moeniValidatePlayback(client, "https://video.example.test/a.ts#download.m3u8", {}), "SEGMENT");
    assert.equal(client.calls.length, 0);
});
test("reject blob before network", async () => {
    const client = mockClient({});
    await rejectsCode(() => api.moeniValidatePlayback(client, "blob:https://example.test/id", {}), "URI");
    assert.equal(client.calls.length, 0);
});
test("do not retry HTTP 403", async () => {
    const client = mockClient({ [base]: response("Denied", 403) });
    await rejectsCode(() => api.moeniValidatePlayback(client, base, {}), "AUTH");
    assert.equal(client.calls.length, 1);
});
test("reject extensionless TS body", async () => {
    const client = mockClient({ [base]: response("G@\0TS") });
    await rejectsCode(() => api.moeniValidatePlayback(client, base, {}), "NOT_HLS");
});
test("do not mistake a query value for the resource extension", async () => {
    const url = "https://video.example.test/playlist?sig=value.ts";
    const client = mockClient({ [url]: response(playlist()) });
    assert.equal((await api.moeniValidatePlayback(client, url, {})).duration, 12);
});
test("master resolves to checked media and preserves provided headers", async () => {
    const child = "https://video.example.test/hls/show/720.m3u8?sig=child";
    const client = mockClient({
        [base]: response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720.m3u8?sig=child"),
        [child]: response(playlist()),
    });
    const headers = { Referer: "https://player.example.test/" };
    const r = await api.moeniValidatePlayback(client, base, headers);
    assert.equal(r.url, child);
    assert.ok(client.calls.every((c) => c.headers === headers));
    assert.equal(client.calls.length, 2);
});
test("master may try next variant after structural failure", async () => {
    const first = "https://video.example.test/hls/show/first.m3u8";
    const second = "https://video.example.test/hls/show/second.m3u8";
    const client = mockClient({
        [base]: response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nfirst.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nsecond.m3u8"),
        [first]: response(playlist([2])),
        [second]: response(playlist()),
    });
    assert.equal((await api.moeniValidatePlayback(client, base, {})).url, second);
});
test("master does not continue after auth denial", async () => {
    const child = "https://video.example.test/hls/show/child.m3u8";
    const client = mockClient({
        [base]: response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nother.m3u8"),
        [child]: response("Denied", 401),
    });
    await rejectsCode(() => api.moeniValidatePlayback(client, base, {}), "AUTH");
    assert.equal(client.calls.length, 2);
});
test("reject looping masters", async () => {
    const client = mockClient({ [base]: response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n" + base) });
    await rejectsCode(() => api.moeniValidatePlayback(client, base, {}), "LIMIT");
});
test("getVideoList returns validated media, not a captured TS", async () => {
    sandbox.evaluateJavascriptViaWebview = () => {};
    const extension = new api.DefaultExtension();
    extension.viaWebview = async () => ({ u: "https://video.example.test/vod/first", ts: false });
    extension.client = mockClient({ "https://video.example.test/vod/first": response("G@\0TS") });
    extension.saveDiag = () => {};
    await rejectsCode(() => extension.getVideoList("/123#" + encodeURIComponent("예제 01화")), "NOT_HLS");
});
test("getVideoList has no success return for explicit TS flag", async () => {
    const extension = new api.DefaultExtension();
    extension.viaWebview = async () => ({ u: "https://video.example.test/vod/first", ts: true });
    extension.client = mockClient({});
    extension.saveDiag = () => {};
    await rejectsCode(() => extension.getVideoList("/123#" + encodeURIComponent("예제 01화")), "SEGMENT");
    assert.equal(extension.client.calls.length, 0);
});
test("getVideoList returns signed checked URL unchanged", async () => {
    const extension = new api.DefaultExtension();
    extension.viaWebview = async () => ({ u: base });
    extension.client = mockClient({ [base]: response(playlist()) });
    extension.saveDiag = () => {};
    const videos = await extension.getVideoList("/123#" + encodeURIComponent("예제 01화"));
    assert.equal(videos.length, 1);
    assert.equal(videos[0].url, base);
    assert.equal(videos[0].originalUrl, base);
});
test("built-in proxy is used for a validated remote HLS when available", async () => {
    const extension = new api.DefaultExtension();
    extension.viaWebview = async () => ({ u: base, headers: { gets: "captured" } });
    extension.client = mockClient({ [base]: response(playlist()) });
    extension.saveDiag = () => {};
    let seen;
    sandbox.createHlsProxyUrl = async (url, headers) => { seen = { url, headers }; return "http://127.0.0.1:1234/native.m3u8"; };
    try {
        const [video] = await extension.getVideoList("/123#episode");
        assert.equal(video.url, "http://127.0.0.1:1234/native.m3u8");
        assert.equal(seen.headers.gets, "captured");
        assert.equal(seen.url, base);
        assert.equal(Object.keys(video.headers).length, 0);
    } finally { delete sandbox.createHlsProxyUrl; }
});
test("register captured inline media without disclosing tokens in the Video headers", async () => {
    const key = "b".repeat(64);
    const url = "http://127.0.0.1:17889/s/" + "a".repeat(48) + "/playlist.m3u8";
    const extension = new api.DefaultExtension();
    extension.viaWebview = async () => ({ inline: { manifest: playlist(), resources: {} }, headers: { gets: "captured-only" } });
    extension.saveDiag = () => {};
    sandbox.SharedPreferences = class { get() { return key; } };
    let seen;
    extension.bridgeClient = {
        async post(address, headers, body) {
            seen = { address, headers, payload: JSON.parse(body) };
            return { statusCode: 201, body: JSON.stringify({ url, duration: 12, segmentCount: 2 }) };
        },
    };
    const [video] = await extension.getVideoList("/123#episode");
    assert.equal(video.url, url);
    assert.equal(Object.keys(video.headers).length, 0);
    assert.equal(seen.headers.Authorization, "Bearer " + key);
    assert.equal(seen.payload.headers.gets, "captured-only");
});
test("missing registration key fails before contacting a server", async () => {
    await rejectsCode(() => api.moeniRegisterInline({}, {}, {}, ""), "BRIDGE_SETUP");
});
test("do not accept a malicious remote URL as the local bridge response", async () => {
    const client = { post: async () => ({ statusCode: 201, body: JSON.stringify({ url: "https://attacker.test/video", duration: 12, segmentCount: 2 }) }) };
    await rejectsCode(() => api.moeniRegisterInline(client, {}, {}, "a".repeat(64)), "BRIDGE_RESPONSE");
});
test("bridge connectivity failure gives a same-device diagnostic", async () => {
    const client = { post: async () => { throw new Error("private token should not appear"); } };
    await rejectsCode(() => api.moeniRegisterInline(client, {}, {}, "a".repeat(64)), "BRIDGE_OFFLINE");
});
test("host WebView timeout is passed directly, without an orphaning Promise.race", async () => {
    let args;
    sandbox.evaluateJavascriptViaWebview = async (...value) => { args = value; return '{"err":"no_manifest"}'; };
    const extension = new api.DefaultExtension();
    const result = await extension.viaWebview("https://moeni.net/123", "https://moeni.net/", "example", 24000);
    assert.equal(result.err, "no_manifest");
    assert.equal(args[3], 24);
    assert.match(args[2][0], /moeniCapturePage/);
    assert.doesNotMatch(args[2][0], /admin|dvD/);
});
async function captureFixture(run) {
    const ticks = [];
    const output = [];
    class BrowserURL extends URL {}
    class Xhr {
        open() {}
        setRequestHeader() {}
        addEventListener() {}
    }
    const context = {
        URL: BrowserURL, Blob, Headers, Uint8Array, btoa,
        XMLHttpRequest: Xhr, Map, Set, Date, String,
        location: { href: "https://moeni.net/123", origin: "https://moeni.net" },
        navigator: { userAgent: "real-webview-ua" },
        document: { querySelector: () => null, querySelectorAll: () => [] },
        setInterval(fn) { ticks.push(fn); return 1; }, clearInterval() {},
        fetch: async () => new Response("unconsumed response"),
        flutter_inappwebview: { callHandler(name, value) { output.push(JSON.parse(value)); } },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext("(" + api.moeniCapturePage.toString() + ")('',24000)", context);
    await run(context);
    await new Promise((resolve) => setImmediate(resolve));
    await ticks[0]();
    return { output, context };
}
test("capture full Blob playlist and matching real request header, not the first TS", async () => {
    const uri = "https://video.modumo.bid/vod/signed-segment";
    const text = playlist().replaceAll(/seg-\d\.ts\?sig=s\d/g, uri);
    const { output, context } = await captureFixture(async (browser) => {
        browser.URL.createObjectURL(new Blob([text], { type: "application/vnd.apple.mpegurl" }));
        await browser.fetch(new Request(uri, { headers: { gets: "issued-by-normal-player" } }));
    });
    assert.equal(output.length, 1);
    assert.equal(output[0].inline.manifest, text);
    assert.equal(output[0].headers.gets, "issued-by-normal-player");
    assert.equal(output[0].headers["User-Agent"], "real-webview-ua");
    assert.equal(output[0].u, undefined);
    assert.equal(context.__moeniCaptureStop, null);
});
test("do not pair an unrelated segment token with the captured manifest", async () => {
    const { output } = await captureFixture(async (browser) => {
        browser.URL.createObjectURL(new Blob([playlist()]));
        await browser.fetch(new Request("https://video.modumo.bid/vod/unrelated", { headers: { gets: "wrong" } }));
    });
    assert.equal(output.length, 0);
});
test("capture required init bytes even after site revokes its Blob URL", async () => {
    const uri = "https://video.modumo.bid/vod/m4s";
    const { output } = await captureFixture(async (browser) => {
        const init = browser.URL.createObjectURL(new Blob(["init-bytes"]));
        const text = playlist().replaceAll(/seg-\d\.ts\?sig=s\d/g, uri).replace("#EXTINF:", `#EXT-X-MAP:URI="${init}"\n#EXTINF:`);
        browser.URL.createObjectURL(new Blob([text]));
        browser.URL.revokeObjectURL(init);
        await browser.fetch(new Request(uri, { headers: { gets: "normal" } }));
    });
    assert.equal(Object.values(output[0].inline.resources)[0].base64, Buffer.from("init-bytes").toString("base64"));
});
