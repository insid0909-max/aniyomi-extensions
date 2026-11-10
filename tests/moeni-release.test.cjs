const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");
const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "js/moeni.js"), "utf8");
const sandbox = {
    MProvider: class {}, Client: class {},
    SharedPreferences: class { get() { return ""; } getString() { return ""; } },
    console, setTimeout, clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(source + "\nglobalThis.release = { meta: mangayomiSources[0], DefaultExtension };", sandbox);
const { meta, DefaultExtension } = sandbox.release;
const entry = index.find((item) => item.id === 1543279642);
test("Moeni source and test index both register version 0.0.6 without changing test identity", () => {
    assert.equal(meta.version, "0.0.6");
    assert.equal(entry.version, meta.version);
    assert.equal(entry.name, "[시험] 모에니");
    assert.equal(entry.baseUrl, meta.baseUrl);
    assert.equal(index.filter((item) => item.id === entry.id).length, 1);
});
test("registered source points at test branch and includes matching cache version", () => {
    const url = new URL(entry.sourceCodeUrl);
    assert.equal(url.origin, "https://raw.githubusercontent.com");
    assert.equal(url.pathname, "/insid0909-max/aniyomi-extensions/test/js/moeni.js");
    assert.equal(url.searchParams.get("v"), meta.version);
});
test("release note and in-app filter explicitly warn about same-device proxy and unverified Android", () => {
    assert.match(entry.notes, /같은 기기/);
    assert.match(entry.notes, /프록시/);
    assert.match(entry.notes, /Android 실기기.*미검증/);
    const headers = new DefaultExtension().getFilterList().filter((item) => item.type_name === "HeaderFilter");
    assert.ok(headers.some((item) => /0\.0\.6/.test(item.name) && /프록시 필요/.test(item.name) && /실기기 미검증/.test(item.name)));
});
test("bridge preference starts empty and distributed source does not fake admin or debugger state", () => {
    const prefs = new DefaultExtension().getSourcePreferences();
    const bridge = prefs.find((item) => item.key === "moeni_bridge_key");
    assert.equal(bridge.editTextPreference.value, "");
    assert.doesNotMatch(source, /localStorage\s*(?:\.\s*setItem\s*\(\s*["']admin|[[]\s*["']admin)/);
    assert.doesNotMatch(source, /Object\.defineProperty\s*\(\s*window\s*,\s*["']dvD/);
});
