const mangayomiSources = [{
    "name": "[시험] 모에니",
    "lang": "ko",
    "baseUrl": "https://moeni.net",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.0.6",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/moeni.js"
}];

// 모에니(moeni.net, 2026-11-10, 애니 전용). 화면은 프로그램이 그리고 자료는 따로 받음:
//   api.moeni.net/web/main (업데이트 12개) · /v1/top (인기) · /web/category/{onair|월…일|완결애니}?sort=(빈 값 날짜순|title)&page=N (30개, total_count)
//   api.modumo.bid/v1/search?f_search=검색어 | genre:"SF" | year:"2025" | format:"movie"|"tv" &page=N (30개)
//   작품 api.moeni.net/web/{id} → {title, date, ep(최근 회차), categories_name}, 표지 img.moeni.net/{id}?i={img}
// 회차 목록은 사이트가 암호로 보내 확장이 풀지 않음 → 최근 회차 번호(ep)로 1~ep 화를 만들고,
// 재생은 숨은 웹뷰에서 정상 플레이어가 만든 전체 Blob 목록과 gets 요청 헤더를 관찰하고,
// 같은 기기의 Node 루프백 프록시에 등록한 HLS 주소를 돌려받음. 단일 TS를 회차로 넘기지 않음.
const DEFAULT_BASE_URL = "https://moeni.net";
const API = "https://api.moeni.net";
const SEARCH_API = "https://api.modumo.bid/v1/search";
const IMG = "https://img.moeni.net";
const LABEL = "모에니";
const KEY = "moeni";
const MOENI_TEST_NOTICE = `시험 ${mangayomiSources[0].version}: Blob HLS · 같은 기기 Node 프록시 필요 · Android 실기기 미검증`;
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Mobile Safari/537.36";
const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

// 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함)
// 분류: [이름, 종류, 값] — cat = /web/category/값, search = 검색 f_search 값, top = /v1/top, main = /web/main
const KINDS = [
    ["최근 업데이트", "search", "format:\"tv\""], ["인기", "top", ""], ["방영중", "cat", "onair"],
    ["월", "cat", "월"], ["화", "cat", "화"], ["수", "cat", "수"], ["목", "cat", "목"], ["금", "cat", "금"], ["토", "cat", "토"], ["일", "cat", "일"],
    ["완결애니", "cat", "완결애니"], ["극장판", "search", "format:\"movie\""], ["업데이트 (첫 화면 12개)", "main", ""],
];
const GENRES = ["전체", "액션", "판타지", "코미디", "로맨스", "드라마", "일상", "모험", "SF", "미스터리", "초자연", "스포츠", "음악",
    "메카", "심리", "스릴러", "공포", "마법소녀", "에로"];
const YEARS = ["전체"].concat(Array.from({ length: 11 }, (_, i) => String(2026 - i)));
const SORTS = [["날짜순", ""], ["제목순", "title"]];
const FILTER_DEFS = [
    ["분류", "kind", KINDS.map((k) => k[0])],
    ["장르 (고르면 분류 대신)", "genre", GENRES],
    ["연도 (고르면 분류 대신)", "year", YEARS],
    ["정렬 (방영중·요일·완결만)", "sort", SORTS.map((s) => s[0])],
];
const RULE_SIZES = FILTER_DEFS.map((d) => d[2].length);
const DEFAULT_POPULAR = [1, 0, 0, 0];
const DEFAULT_LATEST = [0, 0, 0, 0];

let lastSiteRequest = 0;
async function siteWait() {
    const wait = lastSiteRequest + 250 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSiteRequest = Date.now();
}

function ruleText(i) {
    if (i[1] > 0) return `장르 ${GENRES[i[1]]}`;
    if (i[2] > 0) return `${YEARS[i[2]]}년`;
    const k = KINDS[i[0]];
    return k[0] + (k[1] === "cat" && i[3] > 0 ? ` · ${SORTS[i[3]][0]}` : "");
}

function dayMs(s) {
    const m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600000 : 0;
}

function mmdd(ms) {
    const d = new Date(ms + 9 * 3600000).toISOString();
    return d.substring(5, 7) + "." + d.substring(8, 10);
}

function fullDate(ms) {
    const d = new Date(ms + 9 * 3600000);
    const w = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
    return d.toISOString().substring(0, 10).replace(/-/g, ".") + ` (${w})`;
}

// 자료에 글자 종류 표시(charset)가 없으면 망가요미가 Latin-1 로 넘겨 줄 수 있음 → UTF-8 로 되돌림 (애니마루·북코와 같은 코드)
function fixUtf8(s) {
    s = String(s || "");
    if (/[^\u0000-ÿ]/.test(s) || !/[\u0080-ÿ]/.test(s)) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        let n = 0;
        let cp = 0;
        if (c >= 0xc2 && c <= 0xdf) { n = 1; cp = c & 0x1f; }
        else if (c >= 0xe0 && c <= 0xef) { n = 2; cp = c & 0x0f; }
        else if (c >= 0xf0 && c <= 0xf4) { n = 3; cp = c & 0x07; }
        let ok = n > 0 && i + n < s.length;
        for (let k = 1; ok && k <= n; k++) {
            const t = s.charCodeAt(i + k);
            if ((t & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (t & 0x3f);
        }
        if (ok) {
            out += String.fromCodePoint(cp);
            i += n;
        } else {
            out += s[i];
        }
    }
    return out;
}

const QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// 회차용 HLS 인계 검증. 주소 모양이나 TS 한 조각을 "전체 회차"로 취급하지 않는다.
// 인증·키·heartbeat를 만들거나 변경하지 않으며, 기존 Client/headers로 읽을 수 있는 목록만 검증한다.
function moeniPlaybackError(code, message) {
    const error = new Error(`${LABEL} [${code}] ${message}`);
    error.code = code;
    return error;
}

function moeniSafeUrl(value) {
    return String(value || "").split(/[?#]/)[0].replace(/\/\/[^/]*@/, "//");
}

function moeniResolveUri(base, relative) {
    const value = String(relative || "").trim();
    if (!value || /[\u0000-\u0020\\]/.test(value)) throw moeniPlaybackError("URI", "재생목록 URI가 올바르지 않아요");
    if (/^https?:\/\//i.test(value)) return value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw moeniPlaybackError("URI", "HTTP(S) 재생목록만 지원해요");
    const origin = /^(https?:\/\/[^/?#]+)/i.exec(String(base));
    if (!origin) throw moeniPlaybackError("URI", "기준 주소가 올바르지 않아요");
    if (/^\/\//.test(value)) return origin[1].split(":")[0] + ":" + value;
    const cleanBase = String(base).split("#")[0];
    if (value[0] === "?") return cleanBase.split("?")[0] + value;
    if (value[0] === "#") return cleanBase + value;
    const suffixAt = value.search(/[?#]/);
    const path = suffixAt < 0 ? value : value.substring(0, suffixAt);
    const suffix = suffixAt < 0 ? "" : value.substring(suffixAt);
    const basePath = cleanBase.substring(origin[1].length).split("?")[0];
    const joined = path[0] === "/" ? path : basePath.replace(/[^/]*$/, "") + path;
    const parts = [];
    for (const part of joined.split("/")) {
        if (part === "..") parts.pop();
        else if (part && part !== ".") parts.push(part);
    }
    return origin[1] + "/" + parts.join("/") + suffix;
}

function moeniInspectPlaylist(body, url) {
    const text = String(body || "").replace(/^\uFEFF/, "").trim();
    if (text.length > 2 * 1024 * 1024) throw moeniPlaybackError("SIZE", "재생목록 크기가 제한을 초과했어요");
    if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) {
        throw moeniPlaybackError("NOT_HLS", "전체 HLS 목록이 아니에요. TS 조각·JSON·HTML은 재생기에 넘기지 않아요");
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.includes("#EXT-X-I-FRAMES-ONLY")) throw moeniPlaybackError("TRICK_PLAY", "탐색용 영상은 회차로 넘기지 않아요");
    const master = lines.some((line) => /^#EXT-X-STREAM-INF:/.test(line));
    // media 목록만 반환하므로 별도 오디오·자막 렌디션을 잃을 수 있는 master는 조용히 축소하지 않는다.
    if (master && lines.some((line) => /^#EXT-X-MEDIA:/.test(line) && /(?:^|,)URI=/.test(line.substring(13)))) {
        throw moeniPlaybackError("RENDITION", "별도 오디오·자막 목록이 있어요. master를 보존하는 앱 측 인계가 필요해요");
    }
    const variants = [];
    const segments = [];
    let pendingVariant = false;
    let pendingDuration = null;
    let duration = 0;
    let longest = 0;
    for (const line of lines.slice(1)) {
        if (/^#EXT-X-STREAM-INF:/.test(line)) {
            if (pendingVariant) throw moeniPlaybackError("MANIFEST", "화질 주소가 빠졌어요");
            pendingVariant = true;
        } else if (/^#EXTINF:/.test(line)) {
            if (pendingDuration !== null) throw moeniPlaybackError("MANIFEST", "영상 조각 주소가 빠졌어요");
            const match = /^#EXTINF:(\d+(?:\.\d+)?),/.exec(line);
            pendingDuration = match ? Number(match[1]) : NaN;
            if (!Number.isFinite(pendingDuration) || pendingDuration <= 0) throw moeniPlaybackError("MANIFEST", "조각 길이가 올바르지 않아요");
        } else if (line[0] !== "#") {
            const resolved = moeniResolveUri(url, line);
            if (master && pendingVariant && pendingDuration === null) {
                variants.push(resolved);
                pendingVariant = false;
            } else if (!master && pendingDuration !== null && !pendingVariant) {
                segments.push(resolved);
                duration += pendingDuration;
                longest = Math.max(longest, pendingDuration);
                pendingDuration = null;
            } else {
                throw moeniPlaybackError("MANIFEST", "재생목록의 조각·화질 구성이 올바르지 않아요");
            }
        }
    }
    if (pendingVariant || pendingDuration !== null) throw moeniPlaybackError("MANIFEST", "재생목록이 중간에 잘렸어요");
    if (master) {
        if (!variants.length || segments.length) throw moeniPlaybackError("MANIFEST", "화질 목록이 올바르지 않아요");
        return { type: "master", variants };
    }
    const target = lines.find((line) => /^#EXT-X-TARGETDURATION:/.test(line));
    if (!target || !/^#EXT-X-TARGETDURATION:[1-9]\d*$/.test(target) || !segments.length) {
        throw moeniPlaybackError("MANIFEST", "필수 재생목록 정보가 없어요");
    }
    if (Math.round(longest) > Number(target.split(":")[1])) throw moeniPlaybackError("MANIFEST", "조각 길이가 TARGETDURATION보다 커요");
    // 이 소스는 회차 VOD용. 라이브·미완성 목록은 성공으로 반환하지 않는다.
    if (!lines.includes("#EXT-X-ENDLIST")) throw moeniPlaybackError("INCOMPLETE", "완료된 VOD 목록이 아니에요");
    // 10초는 사이트 규격이 아니라 짧은 조각의 잘못된 성공 처리를 막는 보수적인 회차용 정책.
    if (duration < 10) throw moeniPlaybackError("SHORT", `목록 길이가 ${duration}초뿐이에요. 전체 회차인지 확인해야 해요`);
    return { type: "media", duration, segmentCount: segments.length };
}

async function moeniValidatePlayback(client, url, headers) {
    const visited = {};
    let requests = 0;
    async function visit(value, depth) {
        const address = String(value || "");
        if (!/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(address) || /[\u0000-\u0020\\]/.test(address)) {
            throw moeniPlaybackError("URI", "브라우저 내부 blob 주소나 잘못된 주소는 앱에 넘길 수 없어요");
        }
        if (/\.(?:ts|m4s|aac)$/i.test(address.split(/[?#]/)[0])) throw moeniPlaybackError("SEGMENT", "단일 영상 조각은 전체 회차가 아니에요");
        if (depth > 3 || requests >= 8 || visited[address]) throw moeniPlaybackError("LIMIT", "목록 순환 또는 탐색 제한에 도달했어요");
        visited[address] = true;
        requests++;
        const response = await client.get(address, headers);
        const status = Number(response && response.statusCode);
        if (status === 401 || status === 403) throw moeniPlaybackError("AUTH", `HTTP ${status}: 현재 세션에서 거절됐어요. 정상 페이지에서 세션을 다시 만들어야 해요`);
        if (!(status >= 200 && status < 300)) throw moeniPlaybackError("HTTP", `재생목록 요청 실패 (HTTP ${status || "?"})`);
        // Client의 최종 응답 URL 계약이 없어 리다이렉트 기준 경로는 추정하지 않는다.
        const info = moeniInspectPlaylist(response.body, address);
        if (info.type === "media") return Object.assign({ url: address }, info);
        let last = null;
        for (const variant of info.variants.slice(0, 3)) {
            try { return await visit(variant, depth + 1); }
            catch (error) {
                if (error.code === "AUTH") throw error;
                last = error;
            }
        }
        throw last || moeniPlaybackError("MANIFEST", "재생 가능한 화질 목록이 없어요");
    }
    // 원본 master를 그대로 반환하면 검증하지 않은 다른 화질로 전환할 수 있어 검증한 media 목록을 반환한다.
    return visit(url, 0);
}

// This function is serialized into the normal playback WebView. It only observes
// Blob creation and request headers; it does not decode /play or forge /req.
function moeniCapturePage(want, limitMs) {
    if (window.__moeniCaptureStop) window.__moeniCaptureStop();
    const state = { blobs: new Map(), manifests: [], requests: [], remote: [], pending: new Set() };
    const originalCreate = URL.createObjectURL;
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalHeader = XMLHttpRequest.prototype.setRequestHeader;
    let timer, done = false, busy = false, clicked = !want, clickedAt = Date.now(), heldBytes = 0;
    const start = Date.now();
    const normalize = (value) => {
        try { value = decodeURIComponent(value); } catch (_) {}
        return String(value).replace(/[\s-]/g, "");
    };
    function cleanup() {
        clearInterval(timer);
        if (URL.createObjectURL === create) URL.createObjectURL = originalCreate;
        if (window.fetch === fetchHook) window.fetch = originalFetch;
        if (XMLHttpRequest.prototype.open === openHook) XMLHttpRequest.prototype.open = originalOpen;
        if (XMLHttpRequest.prototype.setRequestHeader === headerHook) XMLHttpRequest.prototype.setRequestHeader = originalHeader;
        state.blobs.clear();
        state.manifests.length = state.requests.length = state.remote.length = 0;
        window.__moeniCaptureStop = null;
    }
    function send(value) {
        if (done) return;
        value.clicked = clicked;
        value.elapsedMs = Date.now() - start;
        value.manifestCount = state.manifests.length;
        value.requestCount = state.requests.length;
        done = true;
        cleanup();
        window.flutter_inappwebview.callHandler("setResponse", JSON.stringify(value));
    }
    window.__moeniCaptureStop = () => { done = true; cleanup(); };
    function create(blob) {
        const url = originalCreate.apply(this, arguments);
        if (blob instanceof Blob && blob.size <= 2 * 1024 * 1024 &&
            !/^image\//.test(blob.type) && heldBytes + blob.size <= 8 * 1024 * 1024 && state.blobs.size < 16) {
            state.blobs.set(url, blob);
            heldBytes += blob.size;
            const task = blob.slice(0, 16).text().then(async (head) => {
                if (!done && /^#EXTM3U/.test(head)) {
                    const text = await blob.text();
                    if (!done) state.manifests.push({ text, created: Date.now() });
                }
            }).catch(() => {});
            state.pending.add(task);
            task.finally(() => state.pending.delete(task));
        }
        return url;
    }
    function remember(url, headers) {
        try {
            const address = new URL(typeof url === "string" ? url : url.url, location.href);
            if (address.protocol !== "https:" || !address.hostname.endsWith(".modumo.bid") ||
                !address.pathname.startsWith("/vod/")) return;
            const gets = new Headers(headers).get("gets");
            if (gets) {
                state.requests.push({ url: address.href, gets });
                if (state.requests.length > 32) state.requests.shift();
            }
        } catch (_) {}
    }
    function fetchHook(input, options) {
        remember(input, options?.headers || input?.headers);
        const promise = originalFetch.apply(this, arguments);
        promise.then((response) => {
            // Only inspect likely manifest responses. Never stringify a TS body.
            const address = response.url || (typeof input === "string" ? input : input?.url) || "";
            const type = response.headers.get("content-type") || "";
            if (done || response.status !== 200 ||
                !(/\.m3u8(?:[?#]|$)/i.test(address) || /mpegurl/i.test(type))) return;
            (async () => {
                const reader = response.clone().body?.getReader();
                if (!reader) return;
                let size = 0;
                const chunks = [];
                try {
                    for (;;) {
                        const item = await reader.read();
                        if (item.done) break;
                        size += item.value.length;
                        if (done || size > 2 * 1024 * 1024) { await reader.cancel(); return; }
                        chunks.push(item.value);
                    }
                    const bytes = new Uint8Array(size);
                    let offset = 0;
                    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
                    if (!done && /^#EXTM3U(?:\r?\n|$)/.test(new TextDecoder().decode(bytes))) state.remote.push(address);
                } finally { reader.releaseLock(); }
            })().catch(() => {});
        }).catch(() => {});
        return promise;
    }
    function openHook(method, url) {
        this.__moeniUrl = url;
        this.__moeniGets = "";
        this.addEventListener("loadend", () => {
            if (done) return;
            try {
                if (this.__moeniGets) remember(this.responseURL || this.__moeniUrl, { gets: this.__moeniGets });
                if (this.status === 200 && /^(?:|text)$/.test(this.responseType) &&
                    this.responseText.length <= 2 * 1024 * 1024 &&
                    /^#EXTM3U(?:\r?\n|$)/.test(this.responseText)) state.remote.push(this.responseURL);
            } catch (_) {}
        }, { once: true });
        return originalOpen.apply(this, arguments);
    }
    function headerHook(key, value) {
        if (String(key).toLowerCase() === "gets") this.__moeniGets = String(value);
        return originalHeader.apply(this, arguments);
    }
    URL.createObjectURL = create;
    if (originalFetch) window.fetch = fetchHook;
    XMLHttpRequest.prototype.open = openHook;
    XMLHttpRequest.prototype.setRequestHeader = headerHook;
    async function tick() {
        if (done || busy) return;
        busy = true;
        try {
            if (!clicked) {
                const link = [...document.querySelectorAll('a[href^="#"]')].find((a) =>
                    normalize(a.getAttribute("href").slice(1)) === normalize(want));
                if (link) { clickedAt = Date.now(); clicked = true; link.click(); }
            }
            const candidate = clicked && state.manifests[state.manifests.length - 1];
            if (candidate) {
                const uris = new Set(candidate.text.split(/\r?\n/).filter((line) => line && line[0] !== "#"));
                const matched = state.requests.filter((request) => uris.has(request.url));
                const keys = [...new Set(matched.map((request) => request.gets))];
                if (keys.length === 1) {
                    const resources = {};
                    for (const match of candidate.text.matchAll(/URI="(blob:[^"]+)"/g)) {
                        const blob = state.blobs.get(match[1]);
                        if (!blob || blob.size > 1024 * 1024) { send({ err: "missing_init_blob" }); return; }
                        const bytes = new Uint8Array(await blob.arrayBuffer());
                        let binary = "";
                        for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
                        resources[match[1]] = { base64: btoa(binary) };
                    }
                    if (done) return;
                    send({
                        inline: { manifest: candidate.text, resources },
                        headers: {
                            gets: keys[0], "User-Agent": navigator.userAgent,
                            Referer: location.origin + "/", Origin: location.origin,
                        },
                    });
                    return;
                }
                if (keys.length > 1) { send({ err: "rotating_gets_requires_live_webview" }); return; }
            }
            const remote = state.remote[state.remote.length - 1];
            if (clicked && remote && /^https:/.test(remote)) {
                send({ u: remote, headers: {
                    "User-Agent": navigator.userAgent, Referer: location.origin + "/", Origin: location.origin,
                } });
                return;
            }
            const video = document.querySelector("video");
            if (clicked && video && Date.now() - clickedAt > 3000 && video.paused) {
                video.muted = true;
                video.play()?.catch(() => {});
            }
            if (Date.now() - start >= limitMs - 1500) {
                send({
                    err: !clicked ? "noep" : candidate ? "manifest_without_matching_gets" : "no_manifest",
                    manifestCount: state.manifests.length, requestCount: state.requests.length,
                    blank: location.href === "about:blank",
                });
            }
        } catch (_) { send({ err: "capture_failed" }); }
        finally { busy = false; }
    }
    timer = setInterval(tick, 250);
    tick();
}

async function moeniRegisterInline(client, inline, headers, key) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw moeniPlaybackError("BRIDGE_SETUP", "로컬 프록시 실행 후 확장 설정에 64자리 등록 키를 입력해 주세요");
    let response;
    try {
        response = await client.post("http://127.0.0.1:17889/register", {
            "Content-Type": "application/json", Authorization: "Bearer " + key,
        }, JSON.stringify({ manifest: inline.manifest, resources: inline.resources || {}, headers }));
    } catch (_) {
        throw moeniPlaybackError("BRIDGE_OFFLINE", "같은 기기에서 로컬 프록시를 실행해 주세요. PC의 프록시는 휴대폰에서 접근할 수 없어요");
    }
    if (Number(response.statusCode) !== 201) {
        const status = Number(response.statusCode);
        throw moeniPlaybackError("BRIDGE_HTTP", `로컬 프록시 HTTP ${status}. 등록 키·재생목록·실행 상태를 확인해 주세요`);
    }
    let result;
    try { result = JSON.parse(response.body); } catch (_) {}
    if (!result || !/^http:\/\/127\.0\.0\.1:17889\/s\/[0-9a-f]{48}\/playlist\.m3u8$/.test(result.url) ||
        !Number.isFinite(result.duration) || result.duration < 10 || !(result.segmentCount > 0)) {
        throw moeniPlaybackError("BRIDGE_RESPONSE", "로컬 프록시 응답이 올바르지 않아요");
    }
    return result;
}

function first(el, css) {
    const l = el ? el.select(css) : [];
    return l && l.length ? l[0] : null;
}


// 설정의 선호 화질을 맨 앞으로
function qualitySort(prefKey, list) {
    let want = "자동";
    try {
        const v = new SharedPreferences().get(prefKey);
        want = QUALITY_CHOICES[Number(v)] || (QUALITY_CHOICES.includes(v) ? v : "자동");
    } catch (e) {
        want = "자동";
    }
    const hit = (x) => x.quality.endsWith(` ${want}`) || x.quality.includes(` ${want} `);
    return list.filter(hit).concat(list.filter((x) => !hit(x)));
}

function qualityPreference(key) {
    return {
        key,
        listPreference: {
            title: "선호 화질",
            summary: "영상이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다.",
            valueIndex: 0,
            entries: QUALITY_CHOICES,
            entryValues: QUALITY_CHOICES,
        },
    };
}

// ---------- 인기/최신 탭 규칙 (필터 조건을 탭에 저장) ----------
const RULE_CHOICES = [
    "저장하지 않음 (필터 결과만 보기)",
    "현재 조건을 인기 탭에 저장",
    "현재 조건을 최신 탭에 저장",
    "인기 탭을 기본값으로 복원",
    "최신 탭을 기본값으로 복원",
    "두 탭 모두 기본값으로 복원",
];
const RULE_NAME = "인기/최신 탭 규칙";

// 저장 값은 필터 선택 번호를 쉼표로 이은 문자열. 없거나 맞지 않으면 null (= 기본값)
function ruleRead(prefix, popular, sizes) {
    let raw = "";
    try {
        raw = new SharedPreferences().getString(`${prefix}_${popular ? "pop" : "latest"}_rule`, "") || "";
    } catch (e) {
        return null;
    }
    if (!raw) return null;
    const idx = raw.split(",").map((x) => parseInt(x, 10));
    if (idx.length !== sizes.length || idx.some((v, i) => !(v >= 0 && v < sizes[i]))) return null;
    return idx;
}

function ruleApply(prefix, rule, idx) {
    try {
        const p = new SharedPreferences();
        const pop = `${prefix}_pop_rule`;
        const latest = `${prefix}_latest_rule`;
        const v = idx.join(",");
        if (rule === 1) p.setString(pop, v);
        else if (rule === 2) p.setString(latest, v);
        else if (rule === 3) p.setString(pop, "");
        else if (rule === 4) p.setString(latest, "");
        else if (rule === 5) {
            p.setString(pop, "");
            p.setString(latest, "");
        }
    } catch (e) {
        // 저장 실패는 무시 (필터 결과는 그대로 보여 줌)
    }
}

function ruleFilters(prefix, sizes, defaults, text) {
    const pop = ruleRead(prefix, true, sizes);
    const latest = ruleRead(prefix, false, sizes);
    return [
        { type_name: "SeparatorFilter" },
        { type_name: "HeaderFilter", name: `현재 인기: ${pop ? text(pop) : defaults[0] + " (기본)"}` },
        { type_name: "HeaderFilter", name: `현재 최신: ${latest ? text(latest) : defaults[1] + " (기본)"}` },
        {
            type_name: "SelectFilter", name: RULE_NAME, param: "rule", state: 0,
            values: RULE_CHOICES.map((c, i) => ({ type_name: "SelectOption", name: c, value: String(i) })),
        },
    ];
}


// ---------- 앱 기본 User-Agent 사용 ----------
// 망가요미는 내장 웹뷰에서 Cloudflare 확인을 통과하면 쿠키와 그 웹뷰의 User-Agent 를 함께 저장하고,
// 요청에 User-Agent 가 없을 때만 그 값을 넣는다. 확장이 고정 User-Agent 를 보내면 통과 쿠키가 거부되므로
// 사이트(문서·API) 요청에서는 확장의 User-Agent 를 빼고 앱 값을 쓰게 한다. 영상·이미지 주소 요청은 그대로 둔다.
// 망가요미 변형 앱(Mangayomi Glitch 등)은 User-Agent 를 넣어 주지 않아, 빼고 보내면 사이트가 연결을 끊거나 403 을 줌
// → 그런 응답이면 User-Agent 를 넣어 다시 보내고, 그 뒤로는 처음부터 넣음 (원래 망가요미는 첫 요청이 성공해 그대로)
let APP_NO_UA = false;
let APP_ALT = null;
// 주소를 못 찾는 오류(host lookup 실패)는 바로 할 일이 보이는 쉬운 말로 (2026-11-03)
function dnsFriendly(e, url) {
    const m = String((e && e.message) || e || "");
    if (!/host lookup|UnknownHost|No address associated|nodename nor servname|ERR_NAME_NOT_RESOLVED/i.test(m)) return e;
    const host = (/^https?:\/\/([^/?#]+)/.exec(String(url || "")) || [null, ""])[1];
    return new Error("사이트 주소를 찾지 못했어요. ① 잠시 뒤 다시 ② 앱을 완전히 껐다 켜기 ③ 유니콘 등 DNS 앱을 쓰면 DNS 를 Google 로 ④ 주소가 바뀌었으면 검색창에 새 주소 붙여 넣기" + (host ? ` [${host}]` : ""));
}

function appClient(raw) {
    const media = /\.(?:m3u8|mp4|ts|m4s|jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
    const fallbackUa = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    const strip = (url, headers) => {
        if (!headers || media.test(String(url || ""))) return headers || {};
        const out = {};
        for (const k in headers) if (k.toLowerCase() !== "user-agent") out[k] = headers[k];
        return out;
    };
    const withUa = (headers) => {
        const out = Object.assign({}, headers || {});
        if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) out["User-Agent"] = fallbackUa;
        return out;
    };
    // 망가요미 기본 통신이 끊기면 연결을 재사용하지 않는 별도 통신으로 한 번 더 (애니24에서 효과 확인, DC 확장과 같은 방법)
    const alt = () => {
        if (!APP_ALT) {
            try {
                APP_ALT = new Client({ persistentConnection: false, noProxy: true, timeout: 25, connectTimeout: 10 });
            } catch (e) {
                APP_ALT = null;
            }
        }
        return APP_ALT;
    };
    const send = async (call, url, headers) => {
        if (APP_NO_UA || media.test(String(url || ""))) {
            try {
                return await call(raw, url, APP_NO_UA ? withUa(headers) : headers || {});
            } catch (e) {
                const c = alt();
                if (!c) throw e;
                return call(c, url, withUa(headers));
            }
        }
        let res;
        try {
            res = await call(raw, url, strip(url, headers));
        } catch (e) {
            res = null;
            try {
                const again = await call(raw, url, withUa(headers));
                APP_NO_UA = true;
                return again;
            } catch (e2) {
                const c = alt();
                if (!c) throw e;
                try {
                    return await call(c, url, withUa(headers));
                } catch (e3) {
                    throw e;
                }
            }
        }
        if (res && res.statusCode === 403) {
            try {
                const again = await call(raw, url, withUa(headers));
                if (again && again.statusCode && again.statusCode < 400) {
                    APP_NO_UA = true;
                    return again;
                }
            } catch (e) {}
        }
        return res;
    };
    return {
        get: (url, headers) => send((c, u, h) => c.get(u, h), url, headers).catch((e) => { throw dnsFriendly(e, url); }),
        post: (url, headers, body) => send((c, u, h) => c.post(u, h, body), url, headers).catch((e) => { throw dnsFriendly(e, url); }),
    };
}



class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = appClient(new Client());
    }

    getBaseUrl() {
        return DEFAULT_BASE_URL;
    }

    getHeaders(url) {
        return { "User-Agent": UA, "Referer": `${DEFAULT_BASE_URL}/`, "Origin": DEFAULT_BASE_URL };
    }

    /** 자료(JSON) 받기 */
    async json(url) {
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
            await siteWait();
            try {
                res = await this.client.get(url, Object.assign(this.getHeaders(), { "Accept": "application/json" }));
            } catch (e) {
                if (attempt === 1) throw new Error(`${LABEL} 접속 실패: ${String((e && e.message) || e).substring(0, 80)}`);
                await new Promise((r) => setTimeout(r, 700));
            }
        }
        if (res.statusCode >= 400) throw new Error(`${LABEL} 접속 실패 (HTTP ${res.statusCode})`);
        try {
            return JSON.parse(fixUtf8(res.body));
        } catch (e) {
            throw new Error(`${LABEL} 자료를 읽지 못했어요 [${String(res.body || "").substring(0, 60)}]`);
        }
    }

    /** 목록 카드. 최근 3주 안에 올라온 작품은 제목 뒤 " · MM.dd" (최근 회차 날짜) */
    card(a) {
        let name = String(a.title || "").trim();
        const t = dayMs(a.date);
        if (t && Date.now() - t < 21 * 86400000) name = `${name} · ${mmdd(t)}`;
        return { name, imageUrl: `${IMG}/${a.id}?i=${encodeURIComponent(a.img || "1")}`, link: `/${a.id}` };
    }

    toPage(d, page, per) {
        const arr = Array.isArray(d) ? d : (d && d.data) || [];
        const seen = {};
        const list = arr.filter((a) => a && a.id && !seen[a.id] && (seen[a.id] = true)).map((a) => this.card(a));
        const total = d && !Array.isArray(d) ? Number(d.total_count) || 0 : 0;
        return { list, hasNextPage: !!per && arr.length >= per && (!total || page * per < total) };
    }

    async searchApi(f, page) {
        const u = `${SEARCH_API}?f_search=${encodeURIComponent(f)}` + (page > 1 ? `&page=${page}` : "");
        return this.toPage(await this.json(u), page, 30);
    }

    // ================= 목록 =================
    async listPage(idx, page) {
        if (idx[1] > 0) return this.searchApi(`genre:"${GENRES[idx[1]]}"`, page);
        if (idx[2] > 0) return this.searchApi(`year:"${YEARS[idx[2]]}"`, page);
        const [, kind, value] = KINDS[idx[0]];
        if (kind === "search") return this.searchApi(value, page);
        if (page > 1 && (kind === "top" || kind === "main")) return { list: [], hasNextPage: false };
        if (kind === "top") return this.toPage(await this.json(`${API}/v1/top`), 1, 0);
        if (kind === "main") return this.toPage(await this.json(`${API}/web/main`), 1, 0);
        const u = `${API}/web/category/${encodeURIComponent(value)}?sort=${SORTS[idx[3]][1]}` + (page > 1 ? `&page=${page}` : "");
        return this.toPage(await this.json(u), page, 30);
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return this.listPage(ruleRead(KEY, true, RULE_SIZES) || DEFAULT_POPULAR, page);
    }

    get supportsLatest() {
        return true;
    }

    async getLatestUpdates(page) {
        return this.listPage(ruleRead(KEY, false, RULE_SIZES) || DEFAULT_LATEST, page);
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품 주소(moeni.net/번호)를 붙여 넣으면 그 작품
        const m = /moeni\.net\/(\d+)/.exec(query);
        if (m) {
            const d = await this.getDetail(`/${m[1]}`);
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: `/${m[1]}` }], hasNextPage: false };
        }
        // 검색어 안의 따옴표·쌍점은 사이트 검색 문법과 섞이지 않게 뺌
        if (query) return this.searchApi(query.replace(/[":]/g, " ").replace(/\s+/g, " ").trim(), page);
        const idx = [0, 0, 0, 0];
        let rule = 0;
        for (const f of filters || []) {
            if (!f || f.type_name !== "SelectFilter") continue;
            const k = FILTER_DEFS.findIndex((d) => d[0] === f.name);
            if (k >= 0) idx[k] = Math.min(Math.max(Number(f.state) || 0, 0), RULE_SIZES[k] - 1);
            else if (f.name === RULE_NAME) rule = Number(f.state) || 0;
        }
        if (rule) ruleApply(KEY, rule, idx);
        return this.listPage(idx, page);
    }

    // ================= 작품 정보 · 회차 =================
    idOf(url) {
        const m = /(?:^|\/)(\d+)(?:[/?#]|$)/.exec(String(url || ""));
        if (!m) throw new Error(`작품 주소가 이상해요: ${url}`);
        return m[1];
    }

    async getDetail(url) {
        const id = this.idOf(url);
        const a = await this.json(`${API}/web/${id}`);
        if (!a || !a.title) throw new Error("작품 정보를 찾지 못했어요");
        const title = String(a.title).trim();
        const last = dayMs(a.date);
        const cat = String(a.categories_name || "");
        const ongoing = WEEKDAYS.includes(cat) || /방영/.test(cat);
        const done = /완결|극장/.test(cat);
        const n = Math.max(0, Math.floor(Number(a.ep) || 0));
        const pad = (i) => (i < 10 ? "0" + i : String(i));
        // 회차 목록은 사이트가 암호로 보내 → 최근 회차 번호까지 1화부터 만듦 (최신이 위)
        // 회차 주소 # 뒤는 사이트 화면의 회차 표시와 같은 "제목 NN화" (재생 때 그 회차를 눌러 엶)
        const episodes = [];
        for (let i = n; i >= 1; i--) {
            episodes.push({
                name: `${i}화` + (i === n && last ? ` (${mmdd(last)})` : ""),
                url: `/${id}#${encodeURIComponent(`${title} ${pad(i)}화`)}`,
                dateUpload: i === n && last ? String(last) : null,
            });
        }
        return {
            name: ongoing && last ? `${title} · ${mmdd(last)}` : title,
            imageUrl: `${IMG}/${id}?i=${encodeURIComponent(a.img || "1")}`,
            link: `${DEFAULT_BASE_URL}/${id}`,
            description: [
                last ? `${ongoing ? "방영 중 · " : done ? "완결 · " : ""}최근 회차: ${n}화 · ${fullDate(last)}` : "",
                cat ? `분류: ${WEEKDAYS.includes(cat) ? cat + "요일" : cat}` : "",
                a.path && a.path !== title ? `시리즈: ${a.path}` : "",
            ].filter((x) => x).join("\n"),
            author: "",
            status: ongoing ? 0 : done ? 1 : 5,
            genre: [],
            episodes,
        };
    }

    // ================= 영상 =================
    async getVideoList(url) {
        const id = this.idOf(url);
        const want = decodeURIComponent(String(url).split("#")[1] || "");
        if (!want) throw new Error("회차 주소가 이상해요. 회차 목록을 아래로 당겨 새로고침해 주세요");
        if (typeof evaluateJavascriptViaWebview !== "function") throw new Error("이 망가요미에는 웹뷰 재생 기능이 없어요. 앱을 업데이트해 주세요");
        const diag = [];
        let r = await this.viaWebview(`${DEFAULT_BASE_URL}/${id}`, `${DEFAULT_BASE_URL}/`, want, 24000);
        diag.push("1차 " + this.diagText(r));
        // 영상 주소가 안 보이고 플레이어 틀(iframe)이 있으면 그 틀을 웹뷰로 한 번 더 열어 거기서 찾음
        if ((!r || (!r.u && !r.inline)) && r && (r.iframes || []).length) {
            const frame = r.iframes.find((f) => /^https?:\/\//.test(f) && !/google|doubleclick|disqus|cloudflare|about:/i.test(f));
            if (frame) {
                const r2 = await this.viaWebview(frame, `${DEFAULT_BASE_URL}/`, "", 15000);
                diag.push("틀 " + this.diagText(r2));
                if (r2 && r2.u) r = Object.assign(r2, { ref: frame });
            }
        }
        if (r && r.inline) {
            // This session is registered while the captured bytes still exist;
            // no WebView-local blob URL is handed to the native player.
            const key = String(new SharedPreferences().get(`${KEY}_bridge_key`) || "").trim();
            const registered = await moeniRegisterInline(
                this.bridgeClient || new Client({ noProxy: true, timeout: 10, connectTimeout: 3 }),
                r.inline, r.headers || {}, key,
            );
            this.saveDiag("넘긴 주소 로컬 HLS", [
                `${registered.segmentCount}개 조각 · ${Math.round(registered.duration)}초`,
                "전체 목록과 실제 gets 헤더 인계. Android 연속 재생·토큰 만료는 별도 확인 필요",
            ]);
            return [{ url: registered.url, originalUrl: registered.url, quality: `${LABEL} 로컬 HLS`, headers: {} }];
        }
        if (!r || !r.u) {
            this.saveDiag(want, diag);
            const why = !r ? "응답 없음(시간 초과)" : r.err === "noep" ? `회차 못 찾음 · 화면 회차: ${(r.eps || []).join(", ") || "없음"}` : `영상 주소 못 찾음 · ${r.err || ""}`;
            throw new Error(`영상을 못 불러왔어요 [${why}] · 필터 맨 위 🩺 줄에 자세한 기록`.substring(0, 300));
        }
        const ref = r.ref || `${DEFAULT_BASE_URL}/`;
        const origin = (/^(https?:\/\/[^/]+)/.exec(ref) || [null, DEFAULT_BASE_URL])[1];
        const vh = Object.assign({ "User-Agent": UA, "Referer": ref, "Origin": origin }, r.headers || {});
        const u = String(r.u);
        let checked;
        try {
            if (r.ts) throw moeniPlaybackError("SEGMENT", "TS 조각 하나만 발견했어요. 전체 재생목록이 필요해요");
            checked = await moeniValidatePlayback(this.client, u, vh);
        } catch (error) {
            this.saveDiag("인계 차단", [error.code || "NETWORK", moeniSafeUrl(u)]);
            throw error;
        }
        // 확장자 없는 실제 HLS만 검증 후 앱의 형식 힌트를 붙인다. fragment가 목록을 만드는 것은 아니다.
        const verified = typeof createHlsProxyUrl === "function" ?
            await createHlsProxyUrl(checked.url, vh) : checked.url;
        const v = {
            url: verified,
            originalUrl: /\.m3u8(?:[?#]|$)/i.test(verified) ? verified : verified.replace(/#.*$/, "") + "#download.m3u8",
            quality: `${LABEL} 자동`,
            headers: verified === checked.url ? vh : {},
        };
        this.saveDiag("넘긴 주소 HLS", [`${checked.segmentCount}개 조각 · ${checked.duration}초 (구조 검증, 조각·키 요청은 미검증)`]);
        return [v];
    }

    diagText(r) {
        if (!r) return "응답 없음";
        if (r.inline) return "전체 Blob 목록 확보";
        if (r.u) return "원격 HLS 후보 확보";
        if (r.manifestCount !== undefined || r.requestCount !== undefined) {
            return [
                r.err || "추출 실패",
                r.clicked ? "회차 누름" : "회차 못 누름",
                `전체 목록 ${Number(r.manifestCount) || 0}개`,
                `gets 요청 ${Number(r.requestCount) || 0}개`,
                r.blank ? "빈 페이지로 이동" : "",
                r.elapsedMs !== undefined ? `${Math.round(Number(r.elapsedMs) / 1000)}초` : "",
            ].filter(Boolean).join(" | ");
        }
        const short = (u) => String(u || "").replace(/^https?:\/\//, "").substring(0, 70);
        return [
            r.err || "",
            r.clicked ? "누름" : "안 누름",
            `틀${(r.iframes || []).length}: ${(r.iframes || []).map(short).join(" , ")}`,
            `영상칸${(r.videos || []).length}: ${(r.videos || []).map(short).join(" , ")}`,
            `응답: ${(r.seen || []).join(" , ") || "없음"}`,
            `받은 주소: ${(r.res || []).map(short).join(" , ")}`,
        ].join(" | ");
    }

    saveDiag(want, lines) {
        try {
            new SharedPreferences().setString(`${KEY}_diag`, lines.length ? JSON.stringify([`${want}`].concat(lines)) : "");
        } catch (e) {
            // 기록 실패는 무시
        }
    }

    diagFilters() {
        let lines = [];
        try {
            lines = JSON.parse(new SharedPreferences().getString(`${KEY}_diag`, "") || "[]");
        } catch (e) {
            lines = [];
        }
        if (!lines.length) return [];
        const out = [{ type_name: "HeaderFilter", name: /^넘긴 주소/.test(lines[0]) ? `🩺 마지막 재생: ${lines[0]}` : `🩺 마지막 재생 실패: ${lines[0]}` }];
        for (const l of lines.slice(1)) {
            for (let i = 0; i < l.length && i < 1200; i += 110) out.push({ type_name: "HeaderFilter", name: "🩺 " + l.substring(i, i + 110) });
        }
        return out;
    }

    /**
     * 정상 플레이어의 전체 Blob HLS·초기화 데이터·대응 gets 헤더를 확보한다.
     * HTTP(S) HLS를 직접 관찰한 경우에는 원격 주소를 반환한다. 단일 TS·MP4 후보는 반환하지 않는다.
     */
    async viaWebview(page, referer, want, limitMs) {
        const script = "(" + moeniCapturePage.toString() + ")(" + JSON.stringify(String(want || "")) + "," + Number(limitMs) + ");";
        try {
            // The host owns the timeout and disposes the extraction WebView.
            // A JS Promise.race would return early but leave that WebView running.
            const res = await evaluateJavascriptViaWebview(
                page, { "Referer": referer }, [script], Math.ceil(limitMs / 1000),
            );
            if (!res) return null;
            return JSON.parse(String(res));
        } catch (e) {
            return { err: "웹뷰 오류 " + String((e && e.message) || e).substring(0, 60) };
        }
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        return [
            { type_name: "HeaderFilter", name: "📡 주소: moeni.net" },
            { type_name: "HeaderFilter", name: MOENI_TEST_NOTICE },
            ...notesFilters(KEY),
            ...this.diagFilters(),
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: "검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)" },
        ].concat(FILTER_DEFS.map(([name, param, values]) => ({
            type_name: "SelectFilter", name, param, state: 0,
            values: values.map((v, j) => ({ type_name: "SelectOption", name: v, value: String(j) })),
        })), ruleFilters(KEY, RULE_SIZES, [ruleText(DEFAULT_POPULAR), ruleText(DEFAULT_LATEST)], ruleText));
    }

    getSourcePreferences() {
        return [
            qualityPreference(`${KEY}_quality`),
            {
                key: `${KEY}_bridge_key`,
                editTextPreference: {
                    title: "로컬 HLS 프록시 등록 키",
                    summary: "Blob 재생용. 같은 기기에서 Node 프록시를 실행해야 합니다. 키는 공유하지 마세요.",
                    value: "", dialogTitle: "로컬 프록시 등록 키",
                    dialogMessage: "프록시 시작 화면의 64자리 키. 사이트 로그인 토큰이나 gets 값이 아닙니다.",
                },
            },
        ];
    }
}

// ---------- 업데이트 내역 (필터 맨 위 📝 줄) ----------
// 저장소의 changelog.json 을 1시간에 한 번 받아 두었다가 그 소스의 최근 3개를 보여 줌 (필터 화면을 열 때 기다리지 않음)
const NOTES_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/changelog.json";

async function notesRefresh(client) {
    let p;
    try {
        p = new SharedPreferences();
    } catch (e) {
        return;
    }
    await verRefresh(client, p);
    const last = Number(p.getString("notes_at", "0")) || 0;
    if (Date.now() - last < 60 * 60000) return;
    p.setString("notes_at", String(Date.now()));
    try {
        const r = await client.get(NOTES_URL, {});
        const body = String(r.body || "");
        if (r.statusCode === 200 && body.trim().startsWith("{")) p.setString("notes_json", body);
    } catch (e) {
        // 다음 기회에 다시 받음
    }
}

// ---------- 설치 버전 확인 (필터 맨 위 📝 줄) ----------
// 망가요미는 자동 업데이트를 해도 알림이 없어 → 설치된 버전과 저장소의 최신 버전을 1시간마다 비교해 보여 줌 (2026-11-03)
const VER_INDEX_URLS = ["https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/index.json"];

function verCmp(a, b) {
    const x = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
    const y = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
}

async function verRefresh(client, p) {
    const last = Number(p.getString("ver_at", "0")) || 0;
    if (Date.now() - last < 60 * 60000) return;
    p.setString("ver_at", String(Date.now()));
    const file = String(mangayomiSources[0].pkgPath || "").split("/").pop();
    for (const u of VER_INDEX_URLS) {
        try {
            const r = await client.get(u, {});
            const arr = JSON.parse(String(r.body || "[]"));
            const hit = (Array.isArray(arr) ? arr : []).find((x) => x && String(x.sourceCodeUrl || "").endsWith("/" + file));
            if (hit && hit.version) {
                p.setString("ver_latest", String(hit.version));
                return;
            }
        } catch (e) {
            // 다음 기회에 다시 확인
        }
    }
}

function verLine(key, note) {
    // 버전과 마지막 업데이트 내역을 한 줄로 (필터가 지저분해 보여, 사용자 2026-11-03)
    const mine = String(mangayomiSources[0].version || "");
    let latest = "";
    try {
        latest = new SharedPreferences().getString("ver_latest", "") || "";
    } catch (e) {
        latest = "";
    }
    const last = note && note.t ? ` · ${String(note.d || "").substring(5).replace("-", ".")} ${String(note.t).replace(/^망가요미:\s*/, "")}` : "";
    let name = `📝 ${mine}${last}`;
    if (latest && verCmp(latest, mine) > 0) name = `📝 ⚠️ OLD ${mine} → 새 버전 ${latest} 있음, 확장 화면에서 업데이트`;
    else if (latest) name = `📝 🆕 NEW ${mine}${last}`;
    return { type_name: "HeaderFilter", name, _status: true };
}

function notesFilters(key) {
    let list = [];
    try {
        list = (JSON.parse(new SharedPreferences().getString("notes_json", "") || "{}").items || {})[key] || [];
    } catch (e) {
        list = [];
    }
    return [verLine(key, list.filter((n) => n && n.t)[0])];
}

// ---------- 필터 맨 끝 빈 줄 (2026-11-03) ----------
// 망가요미 필터 창이 휴대폰 하단 버튼(|||·○·<)에 가려 맨 아래 항목이 안 눌림 → 맨 끝에 빈 줄을 두어 위로 올릴 수 있게.
// 맨 끝에만 붙여 기존 필터 순서·저장된 탭 규칙은 그대로
(function () {
    const base = DefaultExtension.prototype.getFilterList;
    DefaultExtension.prototype.getFilterList = function () {
        const list = base.apply(this, arguments) || [];
        return list.concat([1, 2, 3].map(() => ({ type_name: "HeaderFilter", name: "\u3000", _status: true })));
    };
})();

// ---------- 검색 띄어쓰기 (2026-11-05) ----------
// 사이트 검색이 띄어쓰기를 구분해 "괴력난신"·"나혼자만레벨업" 으로는 "괴력 난신"·"나 혼자만 레벨업" 이 안 나오는 곳이 있음.
// 결과가 0개일 때만: ① 띄어쓰기를 뺀 검색어 ② 검색어 앞부분(절반) ③ 두 글자씩(앞에서부터) 으로 최대 6번 다시 찾아,
// 띄어쓰기·기호를 빼고 비교했을 때 검색어가 들어 있는 작품만 보여 줌. 결과가 있으면 원래 그대로
(function () {
    const base = DefaultExtension.prototype.search;
    DefaultExtension.prototype.search = async function (query, page, filters) {
        const r = await base.apply(this, arguments);
        const q = String(query || "").trim();
        if (!q || Number(page) > 1 || /^(?:https?:\/\/|[\w-]+(?:\.[\w-]+)+(?:[/?#]|$))/i.test(q) || (r && r.list && r.list.length)) return r;
        const squash = (s) => String(s || "").normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
        const want = squash(q);
        if (want.length < 2) return r;
        const joined = q.replace(/\s+/g, "");
        const tries = [];
        const add = (t) => { if (t && t.length >= 2 && t !== q && tries.indexOf(t) < 0) tries.push(t); };
        // 사이트 검색은 쉼표·쌍점·물결·괄호·한자 같은 기호가 있으면 못 찾음("밑도 끝도 없이, 너다" 0개, 2026-11-06 검색 검사)
        // → 기호를 뺀 검색어, 앞쪽 단어만으로 먼저 찾아 봄
        const plain = q.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/[\u3400-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
        const words = plain.split(" ").filter((w) => w);
        add(plain);
        if (words.length > 2) add(words.slice(0, words.length - 1).join(" "));
        if (words.length > 1) add(words.slice(0, Math.ceil(words.length / 2)).join(" "));
        add(joined);
        if (joined.length > 2) add(joined.substring(0, Math.max(2, Math.ceil(joined.length / 2))));
        for (let i = 0; i + 2 <= joined.length; i++) add(joined.substring(i, i + 2));
        for (const t of tries.slice(0, 8)) {
            try {
                const r2 = await base.call(this, t, 1, filters);
                const hit = ((r2 && r2.list) || []).filter((x) => squash(x && x.name).includes(want));
                if (hit.length) return { list: hit, hasNextPage: false };
            } catch (e) {
                // 다음 방법으로
            }
        }
        return r;
    };
})();

// ---------- 영화 회차 이름 통일 (2026-11-06, 사용자 "통일시켜") ----------
// 확장마다 영화 회차가 "바로보기"·"한글자막"·"1회 · 바로보기"·"애니감상"·"1. 극장판 X" 처럼 달라서 → "본편" 으로.
// 회차가 하나뿐이고 회차 번호(N화·N회·EN)가 없을 때만 (자막·더빙 같은 구분은 괄호로), 상태를 모르면 완결
(function () {
    const base = DefaultExtension.prototype.getDetail;
    const core = (n) => String(n || "").replace(/^\s*\d+\s*(?:회)?\s*[.·]\s*/, "").replace(/\s*\(\d{2}\.\d{2}\)\s*$/, "").trim();
    const hasNo = (n) => /\d+\s*(?:화|회)|(?:^|\s)E\d+/i.test(core(n));
    const movieName = (n) => {
        const v = (core(n).match(/한글\s*자막|영어\s*자막|자막|더빙|무삭제|감독판|확장판|극장판/g) || [])
            .map((x) => x.replace(/\s+/g, "")).filter((x) => x !== "극장판");
        return v.length ? `본편 (${[...new Set(v)].join(" · ")})` : "본편";
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const eps = (d && d.episodes) || [];
        const variant = /바로\s*보기|본편|자막|더빙|애니감상/;
        const movie = eps.length === 1 ? !hasNo(eps[0].name)
            : eps.length > 1 && eps.every((e) => !hasNo(e.name) && variant.test(core(e.name)));
        if (!movie) return d;
        // 망가요미는 이름 맨 앞 숫자로 회차 번호를 매김 → 숫자가 없으면 "번호를 매길 수 없음" 경고가 떠서 "1. 본편" (사용자, 2026-11-06)
        eps.forEach((e, i) => { e.name = `${i + 1}. ${movieName(e.name)}`; });
        if (d.status === 5 || d.status === undefined) d.status = 1;
        return d;
    };
})();

// ---------- 회차 번호 겹침 막기 (2026-11-07 회차 점검) ----------
// 망가요미는 회차 이름에서 숫자를 읽어 번호를 매기고(lib/utils/chapter_recognition.dart: 작품 제목을 지운 뒤 첫 숫자,
// "season/s/t N"·"ep N" 따로), 번호가 같은 회차는 하나만 남김 → "프롤로그 · 남은 98화"(98)와 "98화"가 겹치거나
// "키스 대신 7초 34화"가 모두 7 이 되어 회차가 사라짐. 같은 방식으로 미리 읽어 보고, 겹치거나 번호가 없는 작품만
// 오래된 회차부터 겹치지 않는 번호를 이름 앞에 붙임("35. …", 겹치면 "39.01. …"). 문제없는 작품은 그대로
(function () {
    const base = DefaultExtension.prototype.getDetail;
    const unwanted = /\b(?:v|ver|vol|version|volume|season|staffel|saison|temporada|s|t)[^a-z]?[0-9]+/g;
    const seasonKw = /\b(?:staffel|season|saison|temporada|s|t)\s*([0-9]+)/;
    const epKw = /\b(?:folge|episode|episodio|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/;
    const chNot = /(?<=ch\.) *([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
    const bare = /([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
    const dec = (d, a) => {
        if (d) return parseFloat(d);
        if (a) {
            if (a.includes("extra")) return 0.99;
            if (a.includes("omake")) return 0.98;
            if (a.includes("special")) return 0.97;
            const t = a.replace(".", "");
            if (t.length === 1) { const k = t.charCodeAt(0) - 96; return k >= 10 ? 0 : k / 10; }
        }
        return 0;
    };
    const read = (title, ch) => {
        let n = String(ch || "").toLowerCase();
        if (title) n = n.split(String(title).toLowerCase()).join("");
        n = n.trim().replace(/,/g, ".").replace(/-/g, ".").replace(/\s(?=extra|special|omake)/g, "");
        const sm = seasonKw.exec(n);
        const season = sm ? sm[1] : "0";
        const em = epKw.exec(n);
        if (em) return { season, ep: parseFloat(em[1]) };
        const s2 = n.replace(unwanted, "");
        const m = chNot.exec(s2) || bare.exec(s2);
        return { season, ep: m ? parseFloat(m[1]) + dec(m[2], m[3]) : null };
    };
    const ok = (list, title) => {
        const seen = {};
        for (const x of list) {
            const r = read(title, x.name);
            if (r.ep === null || !(r.ep > 0)) return false;
            const k = `${r.season}::${r.ep}::${x.scanlator || ""}`;
            if (seen[k]) return false;
            seen[k] = true;
        }
        return true;
    };
    // 붙일 번호 짐작: "34화"·"5회" 를 먼저, 없으면 앱 방식. 확장이 붙인 " · 남은 N화"·" · 마지막"·끝 날짜 "(11.05)" 는 빼고 읽음
    const guessNo = (title, name) => {
        const core = String(name || "").replace(/\s*·\s*(?:남은\s*\d+\s*화|마지막)\s*$/, "").replace(/\s*\(\d{2}(?:\.\d{2}){1,2}\)\s*$/, "");
        const m = /(\d+(?:[.-]\d+)?)\s*(?:화|회|話)/.exec(core);
        if (m) return parseFloat(m[1].replace("-", "."));
        return read(title, core).ep;
    };
    DefaultExtension.prototype.getDetail = async function (url) {
        const d = await base.apply(this, arguments);
        const list = d && (d.episodes || d.chapters);
        if (!list || !list.length) return d;
        const title = String(d.name || "");
        // 앱이 기억한 제목이 조금 달라 지워지지 않는 경우까지 보려고 제목을 지운 것·안 지운 것 둘 다 확인
        if (ok(list, title) && ok(list, "")) return d;
        let last = 0;
        const fmt = (v) => String(Math.round(v * 100) / 100);
        for (let i = list.length - 1; i >= 0; i--) { // 목록은 최신이 위 → 오래된 것부터
            const x = list[i];
            const plain = String(x.name || "").replace(/^\s*\d+(?:\.\d+)?\.\s+/, "");
            const guess = guessNo(title, plain);
            const v = guess !== null && guess > last ? guess : Math.round((last + 0.01) * 100) / 100;
            last = v;
            const lead = /^\s*(\d+(?:\.\d+)?)/.exec(plain);
            x.name = lead && parseFloat(lead[1]) === v && !/^\s*\d+(?:\.\d+)?\s*[-.,]\s*\d/.test(plain) ? plain : `${fmt(v)}. ${plain}`;
        }
        return d;
    };
})();
