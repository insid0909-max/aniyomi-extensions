const mangayomiSources = [{
    "name": "라이브TV",
    "lang": "ko",
    "baseUrl": "https://onair.kbs.co.kr",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/src/ko/tvroom/res/mipmap-xxhdpi/tv_icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.1.0",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "anime/src/ko/livetv.js"
}];

// Aniyomi LiveTv.kt(라이브TV)를 망가요미용으로 옮긴 소스.
// 방송사들이 자기 홈페이지에서 무료로 틀어 주는 실시간 채널 모음 (방송사 공식 주소만).
// 채널 목록은 이 파일 안에 있어서 목록·회차는 인터넷 요청 없이 바로 뜨고,
// 재생할 때만 각 방송사 공식 웹 플레이어가 쓰는 주소에 물어 영상 주소를 받는다. 한국에서만 열리는 방송이 많다.
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Mobile Safari/537.36";
const THUMB = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs/tv.png";
const MEDIA_RE = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g;

const GROUPS = {
    main: "📺 본방송",
    mbc: "🔴 MBC 24시 정주행",
    sbs: "🔵 SBS 24시 정주행",
    kbs: "🟦 KBS 24시 정주행",
    etc: "📡 지역·종교·공공",
    all: "📺 전체 채널",
};

const LABELS = {
    mbic: "MBC 공식",
    mbcmain: "MBC 공식",
    sbsv: "SBS 공식",
    sbsmain: "SBS 공식",
    kbs: "KBS 공식",
    cpbc: "CPBC 공식",
    direct: "방송사 직접",
};

// [묶음, 채널 이름, 재생 방식:값] — Aniyomi LiveTv.kt 의 CHANNELS 와 같은 목록
const CHANNELS = [
    ["main", "KBS1", "kbs:11"],
    ["main", "KBS2", "kbs:12"],
    ["main", "MBC", "mbcmain:"],
    ["main", "SBS", "sbsmain:S01"],
    ["main", "TV조선", "direct:http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s3/playlist.m3u8"],
    ["main", "TV조선2", "direct:http://onair2.cdn.tvchosun.com/origin2/_definst_/tvchosun_s3/playlist.m3u8"],
    ["etc", "가톨릭평화방송 TV", "cpbc:"],
    ["etc", "KFN TV", "direct:http://mediaworks.dema.mil.kr:1935/live_edge/cudo.sdp/playlist.m3u8"],
    ["etc", "광주방송 KBC", "direct:https://vod.ikbc.co.kr/KBCTV/tv/playlist.m3u8"],
    ["etc", "울산방송 UBC", "direct:https://stream.ubc.co.kr/hls/ubctvstream/index.m3u8"],
    ["etc", "여의도순복음교회 FGTV", "direct:https://fgtvlive.fgtv.com/smil:fgtv.smil/playlist.m3u8"],
    ["mbc", "무한도전", "mbic:50"],
    ["mbc", "나 혼자 산다", "mbic:49"],
    ["mbc", "라디오스타", "mbic:48"],
    ["mbc", "무한상사", "mbic:76"],
    ["mbc", "무한도전 추격전", "mbic:94"],
    ["mbc", "진짜 사나이", "mbic:37"],
    ["mbc", "아빠 어디가", "mbic:38"],
    ["mbc", "거침없이 하이킥", "mbic:201"],
    ["mbc", "전원일기", "mbic:43"],
    ["mbc", "내 이름은 김삼순", "mbic:5"],
    ["mbc", "최고의 사랑", "mbic:3"],
    ["mbc", "별순검", "mbic:100"],
    ["mbc", "개와 늑대의 시간", "mbic:177"],
    ["mbc", "구암 허준", "mbic:61"],
    ["sbs", "런닝맨", "sbsv:S22"],
    ["mbc", "이산", "mbic:29"],
    ["mbc", "커피프린스 1호점", "mbic:31"],
    ["mbc", "선덕여왕", "mbic:34"],
    ["mbc", "대장금", "mbic:35"],
    ["mbc", "주몽", "mbic:108"],
    ["mbc", "복면가왕", "mbic:39"],
    ["mbc", "우리 결혼했어요", "mbic:26"],
    ["mbc", "무한도전 스포츠", "mbic:137"],
    ["mbc", "세바퀴", "mbic:144"],
    ["mbc", "놀러와", "mbic:145"],
    ["sbs", "TV 동물농장", "sbsv:S21"],
    ["sbs", "미운 우리 새끼", "sbsv:S23"],
    ["sbs", "백종원의 골목식당", "sbsv:S28"],
    ["sbs", "순풍산부인과", "sbsv:S24"],
    ["sbs", "내 남자의 여자", "sbsv:S25"],
    ["sbs", "야인시대", "sbsv:S26"],
    ["sbs", "올인", "sbsv:S27"],
    ["mbc", "어쩌다 발견한 하루", "mbic:6"],
    ["mbc", "아들과 딸", "mbic:9"],
    ["mbc", "제5공화국", "mbic:13"],
    ["mbc", "육남매", "mbic:14"],
    ["mbc", "영웅시대", "mbic:16"],
    ["mbc", "빛과 그림자", "mbic:18"],
    ["mbc", "궁", "mbic:19"],
    ["mbc", "오자룡이 간다", "mbic:20"],
    ["mbc", "오로라 공주", "mbic:21"],
    ["mbc", "옷소매 붉은 끝동", "mbic:24"],
    ["mbc", "두 번째 남편", "mbic:25"],
    ["mbc", "W-두 개의 세계", "mbic:27"],
    ["mbc", "종합병원", "mbic:30"],
    ["mbc", "뉴 논스톱", "mbic:32"],
    ["mbc", "동이", "mbic:33"],
    ["mbc", "허준", "mbic:40"],
    ["mbc", "상도", "mbic:41"],
    ["mbc", "보고 또 보고", "mbic:42"],
    ["mbc", "하이킥", "mbic:46"],
    ["mbc", "골든타임", "mbic:52"],
    ["mbc", "그대 그리고 나", "mbic:53"],
    ["mbc", "역적: 백성을 훔친 도적", "mbic:54"],
    ["mbc", "킬미힐미", "mbic:55"],
    ["mbc", "환상의 커플", "mbic:56"],
    ["mbc", "안녕, 프란체스카", "mbic:57"],
    ["mbc", "내 딸 금사월", "mbic:59"],
    ["mbc", "반짝반짝 빛나는", "mbic:60"],
    ["mbc", "마의", "mbic:64"],
    ["mbc", "그녀는 예뻤다", "mbic:66"],
    ["mbc", "다모", "mbic:70"],
    ["mbc", "인어아가씨", "mbic:71"],
    ["mbc", "네 멋대로 해라", "mbic:72"],
    ["mbc", "로망스", "mbic:73"],
    ["mbc", "사랑을 그대 품안에", "mbic:78"],
    ["mbc", "불어라 미풍아", "mbic:79"],
    ["mbc", "역도요정 김복주", "mbic:80"],
    ["mbc", "파스타", "mbic:84"],
    ["mbc", "백년의 유산", "mbic:86"],
    ["mbc", "왕꽃 선녀님", "mbic:92"],
    ["mbc", "수사반장", "mbic:98"],
    ["mbc", "히트", "mbic:99"],
    ["mbc", "납량특집극 M", "mbic:103"],
    ["mbc", "검법남녀", "mbic:104"],
    ["mbc", "별은 내 가슴에", "mbic:106"],
    ["mbc", "옥탑방 고양이", "mbic:109"],
    ["mbc", "왔다! 장보리", "mbic:117"],
    ["mbc", "내 뒤에 테리우스", "mbic:118"],
    ["mbc", "꼰대인턴", "mbic:119"],
    ["mbc", "연인", "mbic:120"],
    ["mbc", "피의 게임", "mbic:10"],
    ["mbc", "황금어장 무릎팍도사", "mbic:17"],
    ["mbc", "선을 넘는 녀석들", "mbic:23"],
    ["mbc", "심야괴담회", "mbic:28"],
    ["mbc", "신비한 TV 서프라이즈", "mbic:47"],
    ["mbc", "나는 가수다", "mbic:58"],
    ["mbc", "강호동의 천생연분", "mbic:87"],
    ["mbc", "대한외국인", "mbic:95"],
    ["mbc", "주간아이돌", "mbic:96"],
    ["mbc", "어서와 한국은 처음이지?", "mbic:101"],
    ["mbc", "god의 육아일기", "mbic:102"],
    ["mbc", "태어난 김에 세계일주1", "mbic:105"],
    ["kbs", "쌈, 마이웨이", "kbs:nvod1"],
    ["kbs", "태조 왕건", "kbs:nvod2"],
    ["kbs", "직장의 신", "kbs:nvod3"],
    ["kbs", "아이가 다섯", "kbs:nvod4"],
    ["kbs", "제빵왕 김탁구", "kbs:nvod5"],
    ["kbs", "내 딸 서영이", "kbs:nvod7"],
    ["kbs", "1박 2일", "kbs:nvod6"]
];

// ---------- 화질 나누기 · 선호 화질 ----------
const LIVE_QUALITY_CHOICES = ["자동", "1080p", "720p", "480p", "360p"];

// 마스터 m3u8 본문에서 화질별 주소를 뽑음 (높은 화질부터, 2개 이상일 때만)
function liveVariants(url, body) {
    const text = String(body || "").replace(/\r/g, "");
    const re = /#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)/g;
    const seen = {};
    const out = [];
    let m;
    while ((m = re.exec(text))) {
        const h = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
        if (!h || seen[h[1]]) continue;
        seen[h[1]] = true;
        let u = m[2].trim();
        if (!/^https?:\/\//.test(u)) {
            u = u.startsWith("/") ? (/^(https?:\/\/[^/]+)/.exec(url) || [null, ""])[1] + u : url.replace(/[^/]*(?:\?.*)?$/, "") + u;
        }
        out.push({ h: Number(h[1]), u });
    }
    out.sort((a, b) => b.h - a.h);
    return out.length >= 2 ? out : [];
}

// 설정의 선호 화질이 이름에 든 영상을 맨 앞으로 (자동이면 그대로)
function liveQualitySort(list) {
    let want = "자동";
    try {
        const v = new SharedPreferences().get("ltv_quality");
        want = LIVE_QUALITY_CHOICES[Number(v)] || (LIVE_QUALITY_CHOICES.includes(v) ? v : "자동");
    } catch (e) {
        want = "자동";
    }
    if (want === "자동") return list;
    return list.filter((x) => x.quality.includes(` ${want}`)).concat(list.filter((x) => !x.quality.includes(` ${want}`)));
}

function qParam(url, key) {
    const m = new RegExp(`[?&]${key}=([^&]*)`).exec(String(url || ""));
    if (!m) return "";
    try {
        return decodeURIComponent(m[1].replace(/\+/g, " "));
    } catch (e) {
        return m[1];
    }
}

function compact(s) {
    return String(s || "").replace(/\s/g, "").toLowerCase();
}

class DefaultExtension extends MProvider {
    getHeaders(url) {
        return { "User-Agent": UA };
    }

    channels(group, q) {
        return CHANNELS.filter((c) => (group === "all" || c[0] === group) && (!q || compact(c[1]).includes(compact(q))));
    }

    cardTitle(group, q) {
        const n = this.channels(group, q).length;
        return (q ? `🔎 "${q}"` : (GROUPS[group] || GROUPS.all)) + ` · ${n}채널`;
    }

    card(group, q) {
        return {
            name: this.cardTitle(group, q),
            imageUrl: THUMB,
            link: `/live?g=${group}` + (q ? `&q=${encodeURIComponent(q)}` : ""),
        };
    }

    async getPopular(page) {
        return { list: Object.keys(GROUPS).filter((g) => g !== "all").map((g) => this.card(g, "")), hasNextPage: false };
    }

    get supportsLatest() {
        return false;
    }

    async getLatestUpdates(page) {
        return this.getPopular(page);
    }

    async search(query, page, filters) {
        const q = String(query || "").trim();
        if (!q) return this.getPopular(page);
        return { list: [this.card("all", q)], hasNextPage: false };
    }

    async getDetail(url) {
        const g = GROUPS[qParam(url, "g")] ? qParam(url, "g") : "all";
        const q = qParam(url, "q");
        const episodes = this.channels(g, q).map((c) => ({
            name: c[1],
            url: `/ch?u=${encodeURIComponent(c[2])}`,
            scanlator: g === "all" ? GROUPS[c[0]] : "",
        }));
        return {
            name: this.cardTitle(g, q),
            imageUrl: THUMB,
            link: url,
            description: "방송사 홈페이지에서 무료로 제공하는 실시간 채널입니다.\n" +
                "대부분 한국에서만 재생됩니다. 회차(채널)를 누르면 재생 직전에 방송사에서 영상 주소를 받아 옵니다.",
            status: 0,
            genre: [],
            episodes: episodes,
        };
    }

    // 방송사 공식 웹 플레이어가 쓰는 주소
    apiUrl(kind, arg) {
        const now = Date.now();
        switch (kind) {
            case "mbic": return `https://mediaapi.imbc.com/Player/MbicPlayURLUtil?chid=${arg}`;
            case "mbcmain": return `https://mediaapi.imbc.com/Player/OnAirURLUtil?type=m&t=${now}`;
            case "sbsv": return `https://apis.sbs.co.kr/play-api/1.0/onair/virtual/channel/${arg}` +
                `?v_type=2&platform=pcweb&protocol=hls&ssl=Y&jwt-token=&rnd=${now % 1000}`;
            case "sbsmain": return `https://apis.sbs.co.kr/play-api/1.0/onair/channel/${arg}` +
                "?v_type=2&platform=pcweb&protocol=hls&ssl=Y&rscuse=&jwt-token=&sbsmain=";
            case "kbs": return `https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/${arg}`;
            case "cpbc": return "https://apis.cpbc.co.kr/play-api/2.0/onair/channel/tv?jwt-token=&ssl=Y";
            default: return "";
        }
    }

    headersFor(kind) {
        const h = { "User-Agent": UA };
        if (kind === "mbic" || kind === "mbcmain") {
            h["Referer"] = "https://onair.imbc.com/MbicLive";
            h["Origin"] = "https://onair.imbc.com";
        } else if (kind === "sbsv" || kind === "sbsmain") {
            h["Referer"] = "https://www.sbs.co.kr/live/";
            h["Origin"] = "https://www.sbs.co.kr";
        } else if (kind === "kbs") {
            h["Referer"] = "https://onair.kbs.co.kr/";
        } else if (kind === "cpbc") {
            h["Referer"] = "https://www.cpbc.co.kr/";
        }
        return h;
    }

    // 응답 안에서 재생 주소 찾기. KBS 는 미리보기(preview) 주소도 함께 주므로 그것은 뒤로 미룬다.
    findMedia(body) {
        const text = String(body || "").replace(/\\\//g, "/").replace(/\\u0026/g, "&");
        const all = text.match(MEDIA_RE) || [];
        return all.find((u) => !/preview/i.test(u)) || all[0] || "";
    }

    // 재생 주소가 없을 때 방송사가 준 안내문 (해외 차단·저작권 등)
    reason(body) {
        const re = /"(?:overseas_text|onair_text|msg|message|Message)"\s*:\s*"([^"]{2,120})"/g;
        const msg = [];
        let m;
        while ((m = re.exec(String(body || "")))) {
            if (m[1] !== "OK" && !msg.includes(m[1])) msg.push(m[1]);
        }
        return "재생 주소를 받지 못했습니다" + (msg.length ? ` (${msg.join(" / ")})` : " (한국에서만 재생되는 방송일 수 있습니다)");
    }

    async getVideoList(url) {
        const uri = qParam(url, "u");
        const kind = uri.split(":")[0];
        const arg = uri.substring(kind.length + 1);
        const h = this.headersFor(kind);
        let media = "";
        if (kind === "direct") {
            media = arg;
        } else {
            const api = this.apiUrl(kind, arg);
            if (!api) throw new Error(`알 수 없는 채널: ${uri}`);
            const res = await this.client.get(api, h);
            const body = String(res.body || "");
            media = this.findMedia(body);
            if (!media) throw new Error(this.reason(body));
        }
        const label = LABELS[kind] || "라이브";
        let variants = [];
        try {
            const res = await this.client.get(media, h);
            if (res.statusCode === 200) variants = liveVariants(media, String(res.body));
        } catch (e) {
            variants = [];
        }
        const list = [{ url: media, originalUrl: media, quality: label, headers: h }]
            .concat(variants.map((v) => ({ url: v.u, originalUrl: v.u, quality: `${label} ${v.h}p`, headers: h })));
        return liveQualitySort(list);
    }

    getSourcePreferences() {
        return [
            {
                key: "ltv_quality",
                listPreference: {
                    title: "선호 화질",
                    summary: "방송이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다.",
                    valueIndex: 0,
                    entries: LIVE_QUALITY_CHOICES,
                    entryValues: LIVE_QUALITY_CHOICES,
                },
            },
        ];
    }
}
