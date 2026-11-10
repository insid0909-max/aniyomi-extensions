#!/usr/bin/env node
"use strict";
// Node >=20. A device-local bridge, NOT a public or general-purpose URL proxy.
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const dns = require("node:dns");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pipeline } = require("node:stream/promises");

const MAX_BODY = 12 * 1024 * 1024;
const MAX_MANIFEST = 2 * 1024 * 1024;
const MAX_BLOB = 1024 * 1024;
function fail(code, status = 400) {
    const error = new Error(code);
    error.status = status;
    throw error;
}
function publicAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split(".").map(Number);
        return !([0, 10, 127].includes(a) || a >= 224 ||
            (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) ||
            (a === 198 && (b === 18 || b === 19)));
    }
    // Reject mapped, link-local, ULA, multicast and unspecified IPv6 addresses.
    return net.isIPv6(address) && /^2[0-9a-f]{3}:/i.test(address);
}
function lookupPublic(host, options, callback) {
    dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error);
        const candidates = addresses.filter((entry) => publicAddress(entry.address) &&
            (!options.family || entry.family === options.family));
        if (!candidates.length || candidates.length !== addresses.filter((e) =>
            !options.family || e.family === options.family).length) {
            return callback(new Error("DNS_ADDRESS_BLOCKED"));
        }
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
    });
}
function allowedUpstream(value) {
    let url;
    try { url = new URL(value); } catch (_) { fail("INVALID_UPSTREAM"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        (url.port && url.port !== "443") ||
        !(url.hostname === "modumo.bid" || url.hostname.endsWith(".modumo.bid")) ||
        !url.pathname.startsWith("/vod/")) fail("UPSTREAM_NOT_ALLOWED");
    return url.href;
}
function decodeBlob(entry) {
    if (!entry || typeof entry.base64 !== "string" ||
        entry.base64.length > Math.ceil(MAX_BLOB / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.base64)) {
        fail("INVALID_BLOB");
    }
    const bytes = Buffer.from(entry.base64, "base64");
    if (!bytes.length || bytes.length > MAX_BLOB) fail("INVALID_BLOB");
    return bytes;
}
function compilePayload(payload) {
    const text = payload?.manifest;
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_MANIFEST ||
        !/^#EXTM3U\r?\n/.test(text)) fail("INVALID_MANIFEST");
    if (/#EXT-X-STREAM-INF|#EXT-X-MEDIA:|#EXT-X-I-FRAMES-ONLY/.test(text)) fail("MEDIA_VOD_ONLY");
    const lines = text.trim().split(/\r?\n/);
    if (!lines.includes("#EXT-X-ENDLIST")) fail("INCOMPLETE_VOD");
    const durationTag = lines.find((l) => /^#EXT-X-TARGETDURATION:/.test(l));
    if (!/^#EXT-X-TARGETDURATION:[1-9]\d*$/.test(durationTag || "")) fail("INVALID_TARGETDURATION");
    const targetDuration = Number(durationTag.split(":")[1]);
    const headers = {};
    for (const [key, value] of Object.entries(payload.headers || {})) {
        if (!["gets", "user-agent", "referer", "origin"].includes(key.toLowerCase())) continue;
        if (typeof value !== "string" || /[\r\n\0]/.test(value) || value.length > 8192) fail("INVALID_HEADER");
        headers[key.toLowerCase()] = value;
    }
    if (!headers.gets) fail("MISSING_GETS");
    if (headers.origin && headers.origin !== "https://moeni.net") fail("INVALID_ORIGIN");
    if (headers.referer && !/^https:\/\/moeni\.net\/[^?#]*$/.test(headers.referer)) fail("INVALID_REFERER");
    const blobs = payload.resources || {};
    if (Object.keys(blobs).length > 12) fail("TOO_MANY_BLOBS");
    const resources = [];
    const ids = new Map();
    const usesMap = /#EXT-X-MAP:/.test(text);
    function resource(uri, kind) {
        if (/[\u0000-\u0020\\]/.test(uri)) fail("INVALID_URI");
        const idKey = kind + "\n" + uri;
        if (ids.has(idKey)) return ids.get(idKey);
        if (resources.length >= 20000) fail("TOO_MANY_RESOURCES");
        const index = resources.length;
        const ext = kind === "key" ? "key" : kind === "map" || usesMap ? "mp4" : "ts";
        const name = `r/${index}.${ext}`;
        if (uri.startsWith("blob:")) {
            if (kind !== "map") fail("BLOB_MEDIA_UNSUPPORTED");
            if (!Object.prototype.hasOwnProperty.call(blobs, uri)) fail("MISSING_INIT_BLOB");
            resources.push({ bytes: decodeBlob(blobs[uri]), type: "video/mp4" });
        } else {
            resources.push({
                url: allowedUpstream(uri),
                type: kind === "key" ? "application/octet-stream" : usesMap ? "video/mp4" : "video/mp2t",
            });
        }
        ids.set(idKey, name);
        return name;
    }
    let pending = null, duration = 0, segmentCount = 0;
    const rewritten = lines.map((raw) => {
        const line = raw.trim();
        if (/^#EXTINF:/.test(line)) {
            if (pending !== null) fail("MISSING_SEGMENT");
            const match = /^#EXTINF:(\d+(?:\.\d+)?),/.exec(line);
            pending = match ? Number(match[1]) : NaN;
            if (!Number.isFinite(pending) || pending <= 0 || Math.round(pending) > targetDuration) fail("INVALID_DURATION");
        }
        if (line.startsWith("#")) {
            if (/URI=/.test(line) && !/URI="[^"]+"/.test(line)) fail("INVALID_URI_ATTRIBUTE");
            return line.replace(/URI="([^"]+)"/g, (_, uri) =>
                `URI="${resource(uri, /^#EXT-X-MAP:/.test(line) ? "map" : "key")}"`);
        }
        if (!line) return line;
        if (pending === null) fail("MISSING_EXTINF");
        segmentCount++;
        duration += pending;
        pending = null;
        return resource(line, "segment");
    });
    if (pending !== null || !segmentCount || duration < 10 || duration > 21600) fail("INVALID_VOD_LENGTH");
    return { manifest: Buffer.from(rewritten.join("\n") + "\n"), headers, resources, duration, segmentCount };
}
function rangeFor(value, length) {
    if (!value) return { start: 0, end: length - 1, partial: false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2])) fail("INVALID_RANGE", 416);
    let start, end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) fail("INVALID_RANGE", 416);
        start = Math.max(0, length - suffix);
        end = length - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) fail("INVALID_RANGE", 416);
    return { start, end, partial: true };
}
function openUpstream(url, headers, method, signal) {
    return new Promise((resolve, reject) => {
        const outgoing = https.request(url, {
            method, headers: { ...headers, "accept-encoding": "identity" },
            lookup: lookupPublic, signal,
        }, resolve);
        outgoing.setTimeout(30000, () => outgoing.destroy(new Error("UPSTREAM_TIMEOUT")));
        outgoing.on("error", reject);
        outgoing.end();
    });
}
async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) fail("BODY_TOO_LARGE", 413);
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch (_) { fail("INVALID_JSON"); }
}
function createBridge({ key, upstream = openUpstream, lifetimeMs = 2 * 3600000, maxSessions = 8 } = {}) {
    if (!/^[0-9a-f]{64}$/.test(key || "")) fail("INVALID_REGISTRATION_KEY");
    const sessions = new Map();
    let active = 0;
    const server = http.createServer(async (request, response) => {
        const controller = new AbortController();
        response.on("close", () => controller.abort());
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        try {
            if (request.headers.origin || !/^127\.0\.0\.1:\d+$/.test(request.headers.host || "")) fail("LOCAL_NATIVE_CLIENT_ONLY", 403);
            const url = new URL(request.url, "http://127.0.0.1");
            for (const [id, value] of sessions) if (Date.now() - value.used > lifetimeMs) sessions.delete(id);
            if (url.pathname === "/register") {
                if (request.method !== "POST") fail("METHOD_NOT_ALLOWED", 405);
                const candidate = Buffer.from((request.headers.authorization || "").replace(/^Bearer /, ""));
                if (candidate.length !== 64 || !crypto.timingSafeEqual(candidate, Buffer.from(key))) fail("UNAUTHORIZED", 401);
                if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) fail("JSON_REQUIRED", 415);
                if (sessions.size >= maxSessions) fail("SESSION_LIMIT", 429);
                const session = compilePayload(await readJson(request));
                const id = crypto.randomBytes(24).toString("hex");
                sessions.set(id, { ...session, used: Date.now() });
                const result = {
                    url: `http://127.0.0.1:${server.address().port}/s/${id}/playlist.m3u8`,
                    duration: session.duration, segmentCount: session.segmentCount,
                };
                response.writeHead(201, { "Content-Type": "application/json" });
                response.end(JSON.stringify(result));
                return;
            }
            if (!["GET", "HEAD"].includes(request.method)) fail("METHOD_NOT_ALLOWED", 405);
            const match = /^\/s\/([0-9a-f]{48})\/(playlist\.m3u8|r\/\d+\.(?:ts|mp4|key))$/.exec(url.pathname);
            const session = match && sessions.get(match[1]);
            if (!session) fail("NOT_FOUND", 404);
            session.used = Date.now();
            const item = match[2] === "playlist.m3u8" ? { bytes: session.manifest, type: "application/vnd.apple.mpegurl" } :
                session.resources[Number(match[2].split("/")[1].split(".")[0])];
            if (!item) fail("NOT_FOUND", 404);
            if (item.bytes) {
                const { start, end, partial } = rangeFor(request.headers.range, item.bytes.length);
                response.statusCode = partial ? 206 : 200;
                response.setHeader("Content-Type", item.type);
                response.setHeader("Accept-Ranges", "bytes");
                response.setHeader("Content-Length", end - start + 1);
                if (partial) response.setHeader("Content-Range", `bytes ${start}-${end}/${item.bytes.length}`);
                response.end(request.method === "HEAD" ? undefined : item.bytes.subarray(start, end + 1));
                return;
            }
            if (active >= 12) fail("CONCURRENT_REQUEST_LIMIT", 503);
            active++;
            try {
                const headers = { ...session.headers };
                if (request.headers.range) headers.range = request.headers.range;
                const remote = await upstream(item.url, headers, request.method, controller.signal);
                // Do not follow redirects or leak the session headers to other origins.
                if (remote.statusCode >= 300 && remote.statusCode < 400) {
                    remote.destroy();
                    fail("UPSTREAM_REDIRECT_UNSUPPORTED", 502);
                }
                response.statusCode = remote.statusCode || 502;
                response.setHeader("Content-Type", item.type);
                for (const name of ["content-length", "content-range", "accept-ranges", "retry-after"]) {
                    if (remote.headers[name]) response.setHeader(name, remote.headers[name]);
                }
                if (request.method === "HEAD") { remote.resume(); response.end(); }
                else await pipeline(remote, response);
            } finally { active--; }
        } catch (error) {
            if (response.headersSent) response.destroy();
            else if (!response.destroyed) {
                response.writeHead(error.status || 502, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: error.status ? error.message : "UPSTREAM_IO_ERROR" }));
            }
        }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    return server;
}
module.exports = { createBridge, compilePayload, rangeFor, publicAddress, allowedUpstream };
if (require.main === module) {
    const directory = path.join(os.homedir(), ".config", "moeni-loopback-bridge");
    const configPath = path.join(directory, "config.json");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let key;
    if (fs.existsSync(configPath)) key = JSON.parse(fs.readFileSync(configPath, "utf8")).key;
    else {
        key = crypto.randomBytes(32).toString("hex");
        fs.writeFileSync(configPath, JSON.stringify({ key }), { mode: 0o600, flag: "wx" });
    }
    const server = createBridge({ key });
    server.on("error", (error) => { console.error("Bridge startup failed:", error.code); process.exitCode = 1; });
    server.listen(17889, "127.0.0.1", () => {
        console.log("Moeni local bridge: http://127.0.0.1:17889");
        console.log("Enter this local registration key in the extension preference (do not share):");
        console.log(key);
        console.log("Keep this process running during playback. No upstream URLs or tokens are logged.");
    });
}
