const mangayomiSources = [
    {
      id: 1612480357,
      name: "티비룸",
      lang: "ko",
      baseUrl: "https://tvroom46.org",
      version: "1.0.7",
      isNsfw: !1,
      itemType: 1,
      isManga: !1,
    },
  ],
  USER_AGENT =
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  CATEGORIES = [
    ["드라마", "드라마"],
    ["영화", "영화"],
    ["TV예능", "TV예능"],
    ["음악프로", "음악프로"],
    ["애니", "애니"],
    ["시사다큐", "시사/다큐"],
  ],
  text = (t, e) =>
    String((e ? t.selectFirst(e) : t)?.text || "")
      .replace(/\s+/g, " ")
      .trim(),
  attr = (t, e) => String(t?.attr(e) || "").trim();
class DefaultExtension extends MProvider {
  get supportsLatest() {
    return !0;
  }
  pref(t) {
    try {
      return String(new SharedPreferences().get(t) || "");
    } catch (t) {
      return "";
    }
  }
  get baseUrl() {
    const t = this.pref("base_url").trim().replace(/\/+$/, "");
    if (!t) return this.source.baseUrl;
    if (
      !/^https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(t)
    )
      throw new Error(
        "http:// 또는 https://로 시작하는 사이트 주소를 입력해 주세요.",
      );
    return t;
  }
  get client() {
    return (
      this._client ||
      (this._client = new Client({ timeout: 20, connectTimeout: 8 }))
    );
  }
  getHeaders(t) {
    const e = /^https?:\/\/[^/?#]+/i.exec(String(t || ""))?.[0] || this.baseUrl;
    return { "User-Agent": USER_AGENT, Referer: e + "/" };
  }
  getSourcePreferences() {
    return [
      {
        key: "base_url",
        editTextPreference: {
          title: "사이트 주소",
          summary:
            "주소가 바뀌면 새 주소를 넣어 주세요. 비워 두면 기본 주소를 씁니다.",
          value: "",
          dialogTitle: "사이트 주소",
          dialogMessage: "예: https://tvroom46.org/",
        },
      },
    ];
  }
  path(t, e = !1) {
    let r = String(t)
      .trim()
      .replace(/^https?:\/\/[^/]+(?=\/)/i, "")
      .replace(/&amp;/g, "&")
      .split(/[?#]/)[0];
    try {
      r = decodeURIComponent(r);
    } catch (t) {}
    const s = /^\/video\/([^/]+?)(?:\/([^/]+?))?\/?$/.exec(r);
    if (!s || (e && !s[2]))
      throw new Error(
        e ? "올바른 회차 주소가 아닙니다." : `잘못된 작품 주소입니다: ${t}`,
      );
    return { slug: s[1], episode: s[2] || "", series: `/video/${s[1]}` };
  }
  encode(t) {
    return String(t).replace(/[^\x00-\x7f]+/g, (t) => encodeURIComponent(t));
  }
  async html(t) {
    const e =
      this._pageClient ||
      (this._pageClient = new Client({
        timeout: 20,
        connectTimeout: 8,
        followRedirects: !1,
        useDartHttpClient: !0,
      }));
    let r;
    for (
      let s = 0;
      s < 6 &&
      ((r = await e.get(this.baseUrl + this.encode(t), this.getHeaders())),
      [301, 302, 303, 307, 308].includes(r.statusCode));
      s++
    ) {
      let e = String(
        Object.entries(r.headers || {}).find(
          ([t]) => "location" === t.toLowerCase(),
        )?.[1] || "",
      );
      if (/^[\x00-\xff]*$/.test(e))
        try {
          e = decodeURIComponent(
            [...e]
              .map((t) => "%" + t.charCodeAt(0).toString(16).padStart(2, "0"))
              .join(""),
          );
        } catch (t) {}
      if (
        ((t = e.startsWith(this.baseUrl + "/")
          ? e.slice(this.baseUrl.length)
          : e),
        !/^\/(?!\/)/.test(t))
      )
        throw new Error("사이트 이동 주소가 올바르지 않습니다.");
    }
    if (200 !== r.statusCode)
      throw new Error(`사이트 요청에 실패했습니다 (HTTP ${r.statusCode}).`);
    if (/<title>\s*Just a moment|id=["']cf-chl/i.test(r.body))
      throw new Error(
        "WebView에서 사이트 인증을 완료한 후 다시 시도해 주세요.",
      );
    return r.body;
  }
  async document(t) {
    return new Document(
      (await this.html(t)).replace(
        /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        "",
      ),
    ).body;
  }
  cards(t) {
    const e = new Map();
    for (const r of [
      ...t.select(".v-item"),
      ...t.select(".search-result-item"),
    ]) {
      const t = r.selectFirst("a[href]");
      let s;
      try {
        s = this.path(attr(t, "href")).series;
      } catch (t) {
        continue;
      }
      const i = r.selectFirst("img"),
        n =
          attr(t, "aria-label") ||
          text(r, ".v-item-title") ||
          text(r, ".title") ||
          attr(i, "alt");
      if (!n || e.has(s)) continue;
      const a = attr(i, "data-src") || attr(i, "src");
      e.set(s, {
        name: n,
        link: s,
        imageUrl: /^https?:\/\//i.test(a) ? a : "",
      });
    }
    return [...e.values()];
  }
  async listing(t, e) {
    if (!Number.isSafeInteger(e) || e < 1)
      throw new Error("올바른 목록 페이지가 아닙니다.");
    const r = await this.document(`${t}?page=${e}`),
      s = this.cards(r),
      i = Math.max(
        0,
        ...r
          .select("a.page-link[href]")
          .map((t) => Number(/[?&]page=(\d+)/.exec(attr(t, "href"))?.[1] || 0)),
      );
    return { list: s, hasNextPage: s.length > 0 && i > e };
  }
  getPopular(t) {
    return this.listing("/video/드라마", t);
  }
  async getLatestUpdates(t) {
    return 1 !== t
      ? { list: [], hasNextPage: !1 }
      : { list: this.cards(await this.document("/")), hasNextPage: !1 };
  }
  search(t, e, r) {
    const s = String(t || "").trim();
    if (s) return this.listing(`/search/${encodeURIComponent(s)}`, e);
    const i = (r || []).find((t) => "category" === t.type);
    return this.listing(`/video/${i?.values?.[i.state]?.value || "드라마"}`, e);
  }
  getFilterList() {
    return [
      { type_name: "HeaderFilter", name: "검색어가 있으면 분류는 무시됩니다" },
      {
        type_name: "SelectFilter",
        type: "category",
        name: "분류",
        state: 0,
        values: CATEGORIES.map(([t, e]) => ({
          type_name: "SelectOption",
          name: e,
          value: t,
        })),
      },
    ];
  }
  async getDetail(t) {
    const { series: e } = this.path(t),
      r = await this.document(e),
      s = text(r, ".episode-list a.episode-item-active"),
      i = text(r, "h1"),
      n =
        text(r, ".play-box-side .detail-title strong") ||
        (s && i.endsWith(` - ${s}`) ? i.slice(0, -s.length - 3) : i).trim();
    if (!n)
      throw new Error(
        "작품 정보를 찾지 못했습니다. WebView에서 접속을 확인하세요.",
      );
    const a = [],
      o = new Set();
    for (const t of r.select(".episode-list a.episode-item")) {
      let e;
      try {
        const r = this.path(attr(t, "href"), !0);
        e = `${r.series}/${r.episode}`;
      } catch (t) {
        continue;
      }
      const r = text(t);
      if (!r || o.has(e)) continue;
      o.add(e);
      const s = /(\d{2})(\d{2})(\d{2})$/.exec(r),
        i = s && s[2] >= 1 && s[2] <= 12 && s[3] >= 1 && s[3] <= 31;
      a.push({
        name: r,
        url: e,
        dateUpload: i
          ? String(Date.UTC(2e3 + Number(s[1]), s[2] - 1, Number(s[3])))
          : null,
      });
    }
    if (!a.length) throw new Error("회차 목록을 찾지 못했습니다.");
    const c = {};
    for (const t of r.select(".detail-info-row"))
      c[text(t, ".detail-info-row-side").replace(/:$/, "")] = t
        .select("a")
        .map((t) => text(t))
        .filter(Boolean);
    const l = r.selectFirst(".detail-pic img"),
      h = attr(l, "data-src") || attr(l, "src"),
      u = (c["출연"] || []).join(", ");
    return {
      name: n,
      link: e,
      imageUrl: /^https?:\/\//.test(h) ? h : "",
      description: text(r, ".detail-desc") + (u ? `\n출연: ${u}` : ""),
      author: (c["감독"] || []).join(", "),
      genre: [...(c["장르"] || []), ...(c["국가"] || [])],
      status: 5,
      chapters: a,
    };
  }
  async getVideoList(t) {
    const { series: e, episode: r } = this.path(t, !0),
      s = await this.document(`${e}/${r}`),
      i = attr(s.selectFirst("iframe#view_iframe"), "src");
    if (!/^https:\/\//.test(i))
      throw new Error(
        "재생 정보를 찾지 못했습니다. WebView에서 회차 페이지를 확인하세요.",
      );
    const n = i.replace(/^(https?:\/\/[^/]+).*/, "$1"),
      a = {
        "User-Agent": USER_AGENT,
        Referer: n + "/",
        Origin: n,
        Accept: "*/*",
      },
      o = await this.client.get(i, {
        "User-Agent": USER_AGENT,
        Referer: this.baseUrl + "/",
      });
    if (200 !== o.statusCode)
      throw new Error(
        `플레이어 페이지 요청에 실패했습니다 (HTTP ${o.statusCode}).`,
      );
    const c = /https?:\/\/[^"'\s<>\\]+\/stream\/m3u8\/[^"'\s<>\\]+/.exec(
      String(o.body).replace(/\\\//g, "/"),
    )?.[0];
    if (!c) throw new Error("영상 주소(m3u8)를 찾지 못했습니다.");
    const l = await this.client.get(c, a);
    if (200 !== l.statusCode || !/^#EXTM3U/.test(String(l.body).trim()))
      throw new Error("재생 목록을 받지 못했습니다. 회차를 다시 열어 주세요.");
    const h = { ...a },
      u = /#EXT-X-KEY:[^\n]*URI="(https?:\/\/[^"]+)"/.exec(l.body)?.[1];
    if (u) {
      const t = await this.client.get(u, a);
      if (200 !== t.statusCode)
        throw new Error(`재생 키를 받지 못했습니다 (HTTP ${t.statusCode}).`);
      h["X-Hls-Key"] = this.unscramble(t.body);
    }
    if ("function" != typeof createHlsProxyUrl)
      throw new Error(
        "티비룸 재생에는 HLS 프록시를 지원하는 최신 Mangayomi가 필요합니다. 앱을 업데이트해 주세요.",
      );
    const g = await createHlsProxyUrl(c, a);
    if ("string" != typeof g || !/^http:\/\/127\.0\.0\.1:\d+\//.test(g))
      throw new Error(
        "HLS 프록시를 시작하지 못했습니다. Mangayomi를 업데이트해 주세요.",
      );
    const key = h["X-Hls-Key"] || "";
    const playback = key ? this.localHls(String(l.body), c, g, u, key) : g;
    return [{ url: playback, originalUrl: c, quality: "자동 (HLS)", headers: a }];
  }
  localHls(playlist, base, proxy, keyUrl, keyHex) {
    if (!/^[0-9a-f]{32}$/i.test(keyHex)) throw new Error("재생 키는 16바이트여야 합니다.");
    if (!/^#EXTM3U(?:\r?\n|$)/.test(playlist) || !/#EXT-X-ENDLIST\b/.test(playlist) || /#EXT-X-(?:STREAM-INF|MEDIA):/.test(playlist))
      throw new Error("현재 키 전달 방식은 완성된 단일 HLS 재생목록만 지원합니다.");
    if (playlist.length > 1024 * 1024) throw new Error("재생목록 용량이 너무 큽니다.");
    const prefix = /^(http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)playlist\.m3u8\?url=[A-Za-z0-9_-]+$/.exec(proxy)?.[1];
    if (!prefix) throw new Error("지원하지 않는 HLS 프록시 주소 형식입니다.");
    const fmp4 = /#EXT-X-MAP:/.test(playlist);
    const absolute = (value) => {
      value = String(value).trim();
      if (/^https?:\/\//i.test(value)) return value;
      if (value.startsWith("//")) return /^https?:/.exec(base)[0] + value;
      const origin = /^https?:\/\/[^/]+/i.exec(base)[0];
      const clean = base.replace(/[?#].*$/, "");
      if (value.startsWith("?")) return clean + value;
      const joined = value.startsWith("/") ? value : clean.slice(origin.length).replace(/[^/]*$/, "") + value;
      const parts = /^([^?#]*)([\s\S]*)$/.exec(joined), stack = [];
      for (const part of parts[1].split("/")) {
        if (part === "..") { if (stack.length > 1) stack.pop(); }
        else if (part !== ".") stack.push(part);
      }
      return origin + stack.join("/") + parts[2];
    };
    const resource = (value, type) => {
      const target = absolute(value);
      if (!/^https?:\/\/[^\s]+$/i.test(target)) throw new Error("영상 조각 주소가 올바르지 않습니다.");
      const path = target.replace(/[?#].*$/, "").toLowerCase();
      const name = type === "map" || fmp4 || /\.(?:mp4|m4s|m4a)$/.test(path) ? "segment.mp4" : "segment.ts";
      return prefix + name + "?url=" + encode64Text(target, true);
    };
    const keyBytes = [];
    for (let i = 0; i < keyHex.length; i += 2) keyBytes.push(parseInt(keyHex.slice(i, i + 2), 16));
    const keyData = "data:application/octet-stream;base64," + encode64Bytes(keyBytes);
    let keys = 0;
    const output = playlist.split(/\r?\n/).map((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) {
        return raw.replace(/URI="([^"]+)"/g, (all, value) => {
          if (line.startsWith("#EXT-X-KEY:")) {
            if (!/METHOD=AES-128(?:,|$)/.test(line) || absolute(value) !== keyUrl)
              throw new Error("키 교체 또는 지원하지 않는 암호화 방식입니다.");
            keys++;
            return 'URI="' + keyData + '"';
          }
          if (line.startsWith("#EXT-X-MAP:")) return 'URI="' + resource(value, "map") + '"';
          throw new Error("추가 재생목록 URI는 지원하지 않습니다.");
        });
      }
      return resource(line, "segment");
    }).join("\n");
    if (!keys) throw new Error("재생목록에 키를 연결하지 못했습니다.");
    return "av://hls:data:application/vnd.apple.mpegurl;base64," + encode64Text(output + "\n", false);
  }
  unscramble(t) {
    const e = String(t || "");
    if (16 === e.length && !/^[A-Za-z0-9+/=\s]+$/.test(e))
      return hex(bytesOf(e));
    let r;
    try {
      r = JSON.parse(String.fromCharCode(...base64Bytes(e)));
    } catch (t) {
      r = null;
    }
    const s = r?.rule,
      i = s?.segment_sizes,
      n = s?.permutation,
      a = Number(s?.noise_length || 0);
    if (
      !Array.isArray(i) ||
      !Array.isArray(n) ||
      n.length !== i.length ||
      [...n].sort((t, e) => t - e).some((t, e) => t !== e)
    )
      throw new Error("지원하지 않는 재생 키 형식입니다.");
    const o = base64Bytes(String(r.encrypted_key || "")),
      c = new Array(n.length);
    let l = 0;
    i.forEach((t, e) => {
      (c[n[e]] = o.slice(l, l + t)), (l += t + a);
    });
    const h = c.flat();
    if (h.length !== (Number(s.key_length) || 16) || l > o.length)
      throw new Error("재생 키를 복원하지 못했습니다.");
    return hex(h);
  }
}
function bytesOf(t) {
  const e = [];
  for (let r = 0; r < t.length; r++) e.push(255 & t.charCodeAt(r));
  return e;
}
function hex(t) {
  return t.map((t) => t.toString(16).padStart(2, "0")).join("");
}
function base64Bytes(t) {
  const e = String(t)
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/[^A-Za-z0-9+/]/g, ""),
    r = [];
  let s = 0,
    i = 0;
  for (const t of e)
    (i =
      (i << 6) |
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
        t,
      )),
      (s += 6),
      s >= 8 && ((s -= 8), r.push((i >> s) & 255), (i &= (1 << s) - 1));
  return r;
}


function encode64Bytes(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b = i + 1 < bytes.length, c = i + 2 < bytes.length;
    const n = (bytes[i] << 16) | ((b ? bytes[i + 1] : 0) << 8) | (c ? bytes[i + 2] : 0);
    out += chars[(n >>> 18) & 63] + chars[(n >>> 12) & 63] + (b ? chars[(n >>> 6) & 63] : "=") + (c ? chars[n & 63] : "=");
  }
  return out;
}
function encode64Text(text, urlSafe) {
  const encoded = encodeURIComponent(String(text)), bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  const out = encode64Bytes(bytes);
  return urlSafe ? out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : out;
}
