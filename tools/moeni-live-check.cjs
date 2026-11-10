#!/usr/bin/env node
"use strict";
// Optional integration check. Input contains session secrets: keep it private,
// never commit it, and delete it after this test. No URLs/tokens are printed.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createBridge } = require("./moeni-loopback-bridge.cjs");
(async () => {
    if (!process.argv[2]) throw new Error("Usage: node tools/moeni-live-check.cjs PRIVATE_CAPTURE.json [SECONDS] [--realtime]");
    const seconds = Number(process.argv[3] || 12);
    if (!Number.isInteger(seconds) || seconds < 3 || seconds > 180) throw new Error("SECONDS must be 3..180");
    const realtime = process.argv.includes("--realtime");
    const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const key = crypto.randomBytes(32).toString("hex");
    const bridge = createBridge({ key });
    let child;
    try {
        await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
        const registered = await fetch(`http://127.0.0.1:${bridge.address().port}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body: JSON.stringify(payload),
        });
        if (registered.status !== 201) throw new Error("Register HTTP " + registered.status);
        const { url, duration, segmentCount } = await registered.json();
        const started = Date.now();
        child = spawn("ffmpeg", [
            "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1",
            ...(realtime ? ["-re"] : []),
            "-i", url, "-t", String(seconds), "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-",
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let progress = "", diagnostic = "";
        child.stdout.on("data", (data) => { progress = (progress + data).slice(-12000); });
        child.stderr.on("data", (data) => { diagnostic = (diagnostic + data).slice(-12000); });
        const deadline = setTimeout(() => child.kill("SIGKILL"), (seconds + 45) * 1000);
        const exitCode = await new Promise((resolve, reject) => {
            child.on("error", reject); child.on("close", resolve);
        }).finally(() => clearTimeout(deadline));
        const positions = [...progress.matchAll(/out_time_us=(\d+)/g)].map((m) => +m[1] / 1000000);
        const decodedSeconds = Math.max(0, ...positions);
        const passed = exitCode === 0 && decodedSeconds >= seconds - 0.1;
        console.log(JSON.stringify({
            test: "real capture -> loopback bridge -> FFmpeg decode",
            segmentCount, playlistSeconds: Math.round(duration * 1000) / 1000,
            decodedSeconds, exitCode, passed,
            realtime, elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
            diagnostic: passed ? undefined : diagnostic.replace(/https?:\/\/\S+/g, "[redacted-url]").slice(-800),
        }, null, 2));
        if (!passed) process.exitCode = 1;
    } finally {
        if (child && child.exitCode === null) child.kill("SIGKILL");
        bridge.closeAllConnections();
        await new Promise((resolve) => bridge.close(resolve));
    }
})().catch((error) => { console.error(error.message.replace(/https?:\/\/\S+/g, "[redacted-url]")); process.exitCode = 1; });
