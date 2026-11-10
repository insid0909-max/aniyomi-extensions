const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createBridge, compilePayload, rangeFor, publicAddress } = require("../tools/moeni-loopback-bridge.cjs");
const key = "a".repeat(64);
const segment = (index) => `https://video.modumo.bid/vod/ep-${index}?signed=preserve-${index}`;
const fixture = () => ({
    manifest: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n" + segment(0) +
        "\n#EXTINF:6,\n" + segment(1) + "\n#EXT-X-ENDLIST\n",
    headers: { gets: "normal-player-issued-value", Referer: "https://moeni.net/", Origin: "https://moeni.net", "User-Agent": "same-browser-ua" },
});
async function withServer(t, options = {}) {
    const calls = [];
    const upstream = async (url, headers, method) => {
        calls.push({ url, headers, method });
        const stream = Readable.from([Buffer.from([0x47, 0x40, 0x00, 0x10])]);
        stream.statusCode = 206;
        stream.headers = { "content-length": "4", "content-range": "bytes 0-3/188" };
        return stream;
    };
    const server = createBridge({ key, upstream, ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const base = "http://127.0.0.1:" + server.address().port;
    async function register(payload = fixture(), additionalHeaders = {}) {
        return fetch(base + "/register", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, ...additionalHeaders },
            body: JSON.stringify(payload),
        });
    }
    return { base, register, calls };
}
test("compile a complete VOD without changing signed upstream URLs", () => {
    const value = compilePayload(fixture());
    assert.equal(value.duration, 12);
    assert.equal(value.segmentCount, 2);
    assert.equal(value.resources[0].url, segment(0));
    assert.match(value.manifest.toString(), /r\/0\.ts/);
    assert.doesNotMatch(value.manifest.toString(), /signed=|gets|https:/);
});
for (const uri of ["http://video.modumo.bid/vod/x", "https://127.0.0.1/vod/x",
    "https://video.modumo.bid.attacker.test/vod/x", "https://video.modumo.bid/admin",
    "https://name:password@video.modumo.bid/vod/x", "https://video.modumo.bid:444/vod/x",
    "file:///etc/passwd", "data:text/plain,x"]) {
    test("reject unapproved upstream " + uri, () => {
        const data = fixture();
        data.manifest = data.manifest.replace(segment(0), uri);
        assert.throws(() => compilePayload(data));
    });
}
test("reject a single 2 second segment", () => {
    const data = fixture();
    data.manifest = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n" + segment(0) + "\n#EXT-X-ENDLIST";
    assert.throws(() => compilePayload(data), /INVALID_VOD_LENGTH/);
});
test("reject missing gets rather than forge a token", () => {
    const data = fixture(); delete data.headers.gets;
    assert.throws(() => compilePayload(data), /MISSING_GETS/);
});
test("reject incomplete VOD", () => {
    const data = fixture(); data.manifest = data.manifest.replace("#EXT-X-ENDLIST", "");
    assert.throws(() => compilePayload(data), /INCOMPLETE/);
});
test("preserve an existing key directive and rewrite its allowed URI", () => {
    const data = fixture();
    data.manifest = data.manifest.replace("#EXTINF:", '#EXT-X-KEY:METHOD=AES-128,URI="https://video.modumo.bid/vod/key"\n#EXTINF:');
    const out = compilePayload(data);
    assert.match(out.manifest.toString(), /METHOD=AES-128,URI="r\/0.key"/);
});
test("reject missing init blob", () => {
    const data = fixture();
    data.manifest += '\n#EXT-X-MAP:URI="blob:https://moeni.net/id"';
    assert.throws(() => compilePayload(data), /MISSING_INIT_BLOB/);
});
test("strip unknown headers but retain exactly the captured gets value", () => {
    const data = fixture();
    data.headers.Cookie = "not-forwarded"; data.headers.Authorization = "not-forwarded";
    const out = compilePayload(data);
    assert.deepEqual(Object.keys(out.headers).sort(), ["gets", "origin", "referer", "user-agent"]);
    assert.equal(out.headers.gets, data.headers.gets);
});
test("reject header injection", () => {
    const data = fixture(); data.headers.gets = "value\r\nInjected: yes";
    assert.throws(() => compilePayload(data), /INVALID_HEADER/);
});
test("private addresses are blocked by the DNS guard", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.1.2", "192.168.1.2", "169.254.1.2",
        "100.64.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1"]) assert.equal(publicAddress(address), false, address);
    assert.equal(publicAddress("8.8.8.8"), true);
    assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
test("range semantics include suffixes and reject invalid/multiple ranges", () => {
    assert.deepEqual(rangeFor("bytes=-3", 10), { start: 7, end: 9, partial: true });
    assert.deepEqual(rangeFor("bytes=4-", 10), { start: 4, end: 9, partial: true });
    for (const value of ["bytes=10-", "bytes=4-2", "bytes=-0", "bytes=1-2,3-4"]) assert.throws(() => rangeFor(value, 10));
});
test("register and stream through real loopback HTTP, forwarding gets and Range", async (t) => {
    const { register, calls } = await withServer(t);
    const response = await register();
    assert.equal(response.status, 201);
    const registered = await response.json();
    const manifest = await (await fetch(registered.url)).text();
    const mediaUrl = new URL(manifest.split("\n").find((line) => /^r\//.test(line)), registered.url);
    const media = await fetch(mediaUrl, { headers: { Range: "bytes=0-3" } });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get("content-type"), "video/mp2t");
    assert.equal((await media.arrayBuffer()).byteLength, 4);
    assert.equal(calls[0].headers.gets, fixture().headers.gets);
    assert.equal(calls[0].headers.range, "bytes=0-3");
    assert.equal(calls[0].url, segment(0));
    assert.doesNotMatch(manifest, /normal-player-issued-value/);
});
test("registration requires a local secret and refuses browser Origin requests", async (t) => {
    const { register } = await withServer(t);
    assert.equal((await register(fixture(), { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await register(fixture(), { Origin: "https://attacker.test" })).status, 403);
});
test("unknown playback tokens are rejected", async (t) => {
    const { base } = await withServer(t);
    assert.equal((await fetch(base + "/s/" + "f".repeat(48) + "/playlist.m3u8")).status, 404);
});
test("serve captured init data after the original Blob has been revoked", async (t) => {
    const { register } = await withServer(t);
    const data = fixture();
    data.manifest = data.manifest.replace("#EXTINF:", '#EXT-X-MAP:URI="blob:https://moeni.net/id"\n#EXTINF:');
    data.resources = { "blob:https://moeni.net/id": { base64: Buffer.from("0123456789").toString("base64") } };
    const registered = await (await register(data)).json();
    const manifest = await (await fetch(registered.url)).text();
    const init = new URL(/#EXT-X-MAP:URI="([^"]+)"/.exec(manifest)[1], registered.url);
    const response = await fetch(init, { headers: { Range: "bytes=-3" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 7-9/10");
    assert.equal(await response.text(), "789");
});
test("do not silently evict a playing session when capacity is reached", async (t) => {
    const { register } = await withServer(t, { maxSessions: 1 });
    const first = await (await register()).json();
    assert.equal((await register()).status, 429);
    assert.equal((await fetch(first.url)).status, 200);
});
test("return upstream auth errors; do not manufacture a refresh or retry", async (t) => {
    let count = 0;
    const { register } = await withServer(t, { upstream: async () => {
        count++;
        const r = Readable.from(["Forbidden"]); r.statusCode = 403; r.headers = {};
        return r;
    } });
    const registered = await (await register()).json();
    const response = await fetch(new URL("r/0.ts", registered.url));
    assert.equal(response.status, 403);
    assert.equal(count, 1);
});
test("never follow an upstream redirect carrying captured headers", async (t) => {
    const { register } = await withServer(t, { upstream: async () => {
        const r = Readable.from([]); r.statusCode = 302; r.headers = { location: "https://attacker.test/" }; return r;
    } });
    const registered = await (await register()).json();
    const response = await fetch(new URL("r/0.ts", registered.url));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
});
