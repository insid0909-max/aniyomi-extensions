const mangayomiSources = [{
    "name": "[시험] 망가덱스",
    "lang": "ko",
    "baseUrl": "https://mangadex.org",
    "apiUrl": "https://api.mangadex.org",
    "iconUrl": "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/gh-pages/icon/eu.kanade.tachiyomi.extension.ko.newxtoon.png",
    "typeSource": "single",
    "itemType": 0,
    "isNsfw": false,
    "hasCloudflare": false,
    "version": "0.0.6",
    "dateFormat": "",
    "dateFormatLocale": "",
    "pkgPath": "js/testing/mangadex.js"
}];

// 망가덱스(mangadex.org, 2026-11-10 시험판) — 공개 자료 통로(api.mangadex.org)로 목록·작품·회차·그림을 받음.
// 작품마다 원작 언어(originalLanguage)와 번역된 언어(availableTranslatedLanguages)가 있어 필터로 언어별로 묶음.
// 목록 /manga?limit&offset&availableTranslatedLanguage[]&originalLanguage[]&order[..]&title&status[]&publicationDemographic[]&includedTags[]&excludedTags[]&contentRating[]
// 작품 /manga/{id}?includes[]=author,artist,cover_art · 회차 /manga/{id}/feed?translatedLanguage[]&order[chapter]=desc (500개씩)
// 그림 /at-home/server/{회차id} → {baseUrl}/data/{hash}/{파일} (데이터 절약은 /data-saver/)
const API = "https://api.mangadex.org";
const SITE = "https://mangadex.org";
const COVERS = "https://uploads.mangadex.org/covers";
// 망가덱스 자료 통로는 브라우저 이름(User-Agent)으로 부르면 "Bot challenge" 403 → 앱 이름으로 부름(망가덱스가 앱들에게 권하는 방식)
const UA = "Mangayomi-KoExt/0.0.6";
const PAGE = 30;
const MAX_OFFSET = 10000; // 망가덱스는 offset+limit 1만까지만 줌
const NOTE_KEY = "mangadex";

// 필터 (이름으로 찾음 — 순서를 바꾸면 저장된 탭 규칙이 맞지 않을 수 있음)
const F_LANG = "번역 언어";
const F_ORIG = "원작 언어 (작품 묶기)";
const F_SORT = "정렬";
const F_STATUS = "연재 상태";
const F_RATING = "연령 등급";
const F_DEMO = "대상 독자";
const F_GENRE = "장르 (한 번 누르면 포함, 두 번 누르면 빼기)";
const F_RULE = "인기/최신 탭 규칙";

const LANGS = [
    ["설정의 회차 언어 (기본 한국어)", ""], ["한국어", "ko"], ["영어", "en"], ["일본어", "ja"], ["중국어 (간체)", "zh"],
    ["중국어 (번체)", "zh-hk"], ["스페인어 (중남미)", "es-la"], ["포르투갈어 (브라질)", "pt-br"], ["프랑스어", "fr"],
    ["인도네시아어", "id"], ["베트남어", "vi"], ["태국어", "th"], ["러시아어", "ru"], ["모든 언어", "*"],
];
const ORIGS = [
    ["전체", []], ["일본 (만화)", ["ja"]], ["한국 (웹툰·만화)", ["ko"]], ["중국 (만화)", ["zh", "zh-hk"]],
    ["영어권 (코믹스)", ["en"]], ["그 밖의 나라", ["fr", "es", "es-la", "pt-br", "id", "vi", "th", "ru", "de", "it"]],
];
const SORTS = [
    ["최근 업데이트", "latestUploadedChapter", "desc"], ["인기 (팔로우 많은 순)", "followedCount", "desc"],
    ["평점 높은 순", "rating", "desc"], ["새로 등록된 순", "createdAt", "desc"], ["발표 연도 최신 순", "year", "desc"],
    ["제목 가나다순", "title", "asc"], ["검색어와 가까운 순", "relevance", "desc"],
];
const STATUSES = [["전체", ""], ["연재 중", "ongoing"], ["완결", "completed"], ["휴재", "hiatus"], ["연재 중단", "cancelled"]];
const RATINGS = [
    ["전체 연령 + 약간 선정적", ["safe", "suggestive"]], ["전체 연령만", ["safe"]],
    ["성인 포함 (모두)", ["safe", "suggestive", "erotica", "pornographic"]],
];
const DEMOS = [["전체", ""], ["소년", "shounen"], ["소녀", "shoujo"], ["청년", "seinen"], ["여성", "josei"]];
const RULES = [
    "저장하지 않음 (필터 결과만 보기)", "현재 조건을 인기 탭에 저장", "현재 조건을 최신 탭에 저장",
    "인기 탭을 기본값으로 복원", "최신 탭을 기본값으로 복원", "두 탭 모두 기본값으로 복원",
];

// 장르·주제·형식 (망가덱스 태그 번호, 2026-11-10 /manga/tag 그대로 · 이름은 한국어로)
const TAGS = [
    ["391b0423-d847-456f-aff0-8b0cfc03066b", "액션"], ["87cc87cd-a395-47af-b27a-93258283bbc6", "모험"],
    ["4d32cc48-9f00-4cca-9b5a-a839f0764984", "코미디"], ["b9af3a63-f058-46de-a9a0-e0c13906197a", "드라마"],
    ["cdc58593-87dd-415e-bbc0-2ec27bf404cc", "판타지"], ["423e2eae-a7a2-4a8b-ac03-a8351462d71d", "로맨스"],
    ["e5301a23-ebd9-49dd-a0cb-2add944c7fe9", "일상"], ["ace04997-f6bd-436e-b261-779182193d3d", "이세계"],
    ["5920b825-4181-4a17-beeb-9918b0ff7a30", "BL"], ["a3c67850-4684-404e-9b7f-c69850ee5da6", "백합(GL)"],
    ["5ca48985-9a9d-4bd8-be29-80dc0303db72", "범죄"], ["33771934-028e-4cb3-8744-691e866a923e", "역사"],
    ["cdad7e68-1419-41dd-bdce-27753074a640", "공포"], ["81c836c9-914a-4eca-981a-560dad663e73", "마법소녀"],
    ["50880a9d-5440-4732-9afb-8f457127e836", "메카"], ["c8cbe35b-1b2b-4a3f-9c37-db84c4514856", "의학"],
    ["ee968100-4191-4968-93d3-f82d72be7e46", "미스터리"], ["b1e97889-25b4-4258-b28b-cd7f4d28ea9b", "철학"],
    ["3b60b75c-a2d7-4860-ab56-05f391bb889c", "심리"], ["256c8bd9-4904-4360-bf4f-508a76d67183", "SF"],
    ["69964a64-2f90-4d33-beeb-f3ed2875eb4c", "스포츠"], ["7064a261-a137-4d3a-8848-2d385de3a99c", "슈퍼히어로"],
    ["07251805-a27e-4d59-b488-f0bfbec15168", "스릴러"], ["f8f62932-27da-4fe4-8ee1-6779a8c5edba", "비극"],
    ["acc803a4-c95a-4c22-86fc-eb6b582d82a2", "무협"],
    ["e64f6742-c834-471d-8d72-dd51fc02b835", "외계인"], ["3de8c75d-8ee3-48ff-98ee-e20a65c86451", "동물"],
    ["ea2bc92d-1c26-4930-9b7c-d5c0dc1b6869", "요리"], ["9ab53f92-3eed-4e9b-903a-917c86035ee3", "여장·남장"],
    ["da2d50ca-3018-4cc0-ac7a-6b7d472a29ea", "불량아"], ["39730448-9a5f-48a2-85b0-a70db87b1233", "악마"],
    ["2bd2e8d0-f146-434a-9b51-fc9ff2c5fe6a", "성전환"], ["3bb26d85-09d5-4d2e-880c-c34b974339e9", "유령"],
    ["fad12b5e-68ba-460e-b933-9ae8318f5b65", "갸루"], ["aafb99c1-7f60-43fa-b75f-fc9502ce29c7", "하렘"],
    ["85daba54-a71c-4554-8a28-9901a8b0afad", "마피아"], ["a1f53773-c69a-4ce5-8cab-fffcd90b1565", "마법"],
    ["cb562697-929f-4d28-9d66-6d3995bf2592", "마작"], ["799c202e-7daa-44eb-9cf7-8a3c0441531e", "무술"],
    ["ac72833b-c4e9-4878-b9db-6c8a4a99444a", "군대"], ["dd1f77c5-dea9-4e2b-97ae-224af09caf99", "몬스터 소녀"],
    ["36fd93ea-e8b8-445e-b836-358f02b3d33d", "괴물"], ["f42fbf9e-188a-447b-9fdc-f19dc1e4d685", "음악"],
    ["489dd859-9b61-4c37-af75-5b18e88daafc", "닌자"], ["92d6d951-ca5e-429c-ac78-451071cbf064", "직장인"],
    ["df33b754-73a3-4c54-80e6-1a74a8058539", "경찰"], ["9467335a-1b83-4497-9231-765337a00b96", "아포칼립스"],
    ["0bc90acb-ccc1-44ca-a34a-b9f3a73259d0", "환생"], ["65761a2a-415e-47f3-bef2-a9dababba7a6", "역하렘"],
    ["81183756-1453-4c81-aa9e-f6e1b63be016", "사무라이"], ["caaa44eb-cd40-4177-b930-79d3ef2afe87", "학원"],
    ["eabc5b4c-6aff-42f3-b657-3e90cbd00b75", "초자연"], ["5fff9cde-849c-4d78-aab0-0d52b2ee1d25", "생존"],
    ["292e862b-2d17-4062-90a2-0356caa4ae27", "시간 여행"], ["31932a7e-5b8e-49a6-9f12-2afa39dc544c", "전통 놀이"],
    ["d7d1730f-6eb0-4ba6-9437-602cac38664c", "뱀파이어"], ["9438db5a-7e2a-4ac0-b39e-e0d95a34b8a8", "게임"],
    ["d14322ac-4d6f-4e9b-afd9-629d5f4d8a41", "악역 영애"], ["8c86611e-fab7-4986-9dec-d1a2f44acdd5", "가상 현실"],
    ["631ef465-9aba-4afb-b0fc-ea10efe274a8", "좀비"],
    ["b11fda93-8f1d-4bef-b2ed-8803d3733170", "4컷"], ["f4122d1c-3b44-44d0-9936-ff7502c39ad3", "원작 각색"],
    ["51d83883-4103-437c-b4b1-731cb73d786c", "단편 모음"], ["0a39b5a1-b235-4886-a747-1d05d216532d", "수상작"],
    ["b13b2a48-c720-44a9-9c77-39c9979373fb", "동인지"], ["f5ba408b-0e7a-484d-8d49-4e9125ac96de", "올컬러"],
    ["3e2b8dae-350e-4ab8-a8ce-016e844b9f0d", "세로 스크롤(웹툰)"], ["0234a31e-a729-4e28-9d6a-3f87c4966b9e", "단편"],
    ["e197df38-d0e7-43b5-9b09-2842d0c326dd", "웹코믹"], ["891cf039-b895-47f0-9229-bef4c96eccd4", "자가 출판"],
    ["b29d6a3d-1569-4e7a-8caf-7557bc92cd5d", "잔혹"], ["97893a4c-12af-4dac-b6be-0dffb353568e", "성폭력 묘사"],
];
const TAG_KO = {};
for (const t of TAGS) TAG_KO[t[0]] = t[1];
const LANG_KO = {
    ko: "한국어", en: "영어", ja: "일본어", zh: "중국어(간체)", "zh-hk": "중국어(번체)", "es-la": "스페인어(중남미)", es: "스페인어",
    "pt-br": "포르투갈어(브라질)", pt: "포르투갈어", fr: "프랑스어", id: "인도네시아어", vi: "베트남어", th: "태국어", ru: "러시아어",
    tr: "튀르키예어", de: "독일어", it: "이탈리아어", pl: "폴란드어", ar: "아랍어", uk: "우크라이나어", ms: "말레이어", tl: "필리핀어",
    fil: "필리핀어", hu: "헝가리어", cs: "체코어", ro: "루마니아어", he: "히브리어", fa: "페르시아어", bn: "벵골어", hi: "힌디어",
    nl: "네덜란드어", sv: "스웨덴어", ca: "카탈루냐어", el: "그리스어", my: "미얀마어", mn: "몽골어", lt: "리투아니아어", bg: "불가리아어",
    sr: "세르비아어", hr: "크로아티아어", da: "덴마크어", no: "노르웨이어", fi: "핀란드어", ta: "타밀어", kk: "카자흐어", uz: "우즈베크어",
    sk: "슬로바키아어", et: "에스토니아어", lv: "라트비아어", ka: "조지아어", az: "아제르바이잔어", ne: "네팔어", ur: "우르두어",
    eo: "에스페란토", la: "라틴어", "ja-ro": "일본어(로마자)", "ko-ro": "한국어(로마자)", "zh-ro": "중국어(로마자)",
};
const STATUS_KO = { ongoing: 0, completed: 1, hiatus: 2, cancelled: 3 };

function prefs() {
    try {
        return new SharedPreferences();
    } catch (e) {
        return null;
    }
}

function pref(key, def) {
    const p = prefs();
    if (!p) return def;
    try {
        const v = p.get(key);
        return v === null || v === undefined || v === "" ? def : v;
    } catch (e) {
        return def;
    }
}

/** 회차를 보여 줄 언어 (설정, 기본 한국어) */
function chapterLang() {
    return String(pref("mdx_lang", "ko") || "ko");
}

function mmdd(iso) {
    const t = Date.parse(iso || "");
    if (isNaN(t)) return "";
    const d = new Date(t + 9 * 3600000).toISOString();
    return d.substring(5, 7) + "." + d.substring(8, 10);
}

/** 제목: 한국어 제목이 있으면 그것, 없으면 영어, 없으면 처음 것 */
function titleOf(a) {
    const alt = (a && a.altTitles) || [];
    const ko = alt.find((x) => x && x.ko);
    if (ko) return String(ko.ko).trim();
    const t = (a && a.title) || {};
    if (t.ko) return String(t.ko).trim();
    if (t.en) return String(t.en).trim();
    const first = Object.keys(t)[0];
    if (first) return String(t[first]).trim();
    const en = alt.find((x) => x && x.en);
    return en ? String(en.en).trim() : "(제목 없음)";
}

function coverOf(m) {
    const c = (m.relationships || []).find((r) => r && r.type === "cover_art" && r.attributes && r.attributes.fileName);
    return c ? `${COVERS}/${m.id}/${c.attributes.fileName}.256.jpg` : "";
}

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return { "User-Agent": UA };
    }

    get supportsLatest() {
        return true;
    }

    /** 자료 통로 요청 (실패하면 오류 끝에 [단계 · HTTP · 응답 앞부분]) */
    async api(path, stage) {
        let res = null;
        let last = "";
        for (let i = 0; i < 2 && !res; i++) {
            try {
                const r = await this.client.get(API + path, { "User-Agent": UA, "Accept": "application/json" });
                if (r.statusCode === 429 || r.statusCode >= 500) {
                    last = `HTTP ${r.statusCode}`;
                    await new Promise((ok) => setTimeout(ok, 1200));
                    continue;
                }
                res = r;
            } catch (e) {
                last = String((e && e.message) || e).substring(0, 60);
                await new Promise((ok) => setTimeout(ok, 700));
            }
        }
        if (!res) throw new Error(`망가덱스에 연결되지 않았어요 [${stage} · ${last}]`);
        const body = String(res.body || "");
        let data = null;
        try {
            data = JSON.parse(body);
        } catch (e) {
            data = null;
        }
        if (res.statusCode >= 400 || !data || data.result === "error") {
            const why = data && data.errors && data.errors[0] ? `${data.errors[0].title || ""} ${data.errors[0].detail || ""}`.trim() : body.replace(/\s+/g, " ");
            throw new Error(`망가덱스 요청 실패 [${stage} · HTTP ${res.statusCode} · ${why.substring(0, 80)}]`);
        }
        return data;
    }

    // ================= 필터 읽기 =================
    /** 망가요미가 돌려준 필터(또는 저장된 탭 규칙)를 조건으로 바꿈 */
    readFilters(filters) {
        const q = { lang: 0, orig: 0, sort: 0, status: 0, rating: 0, demo: 0, inc: [], exc: [], rule: 0 };
        for (const f of filters || []) {
            if (!f) continue;
            const s = Number(f.state) || 0;
            if (f.name === F_LANG) q.lang = s;
            else if (f.name === F_ORIG) q.orig = s;
            else if (f.name === F_SORT) q.sort = s;
            else if (f.name === F_STATUS) q.status = s;
            else if (f.name === F_RATING) q.rating = s;
            else if (f.name === F_DEMO) q.demo = s;
            else if (f.name === F_RULE) q.rule = s;
            else if (f.name === F_GENRE && Array.isArray(f.state)) {
                f.state.forEach((t, i) => {
                    const st = Number(t && t.state) || 0;
                    const id = (t && t.value) || (TAGS[i] && TAGS[i][0]);
                    if (!id) return;
                    if (st === 1) q.inc.push(id);
                    else if (st === 2) q.exc.push(id);
                });
            }
        }
        const clamp = (v, arr) => (v >= 0 && v < arr.length ? v : 0);
        q.lang = clamp(q.lang, LANGS);
        q.orig = clamp(q.orig, ORIGS);
        q.sort = clamp(q.sort, SORTS);
        q.status = clamp(q.status, STATUSES);
        q.rating = clamp(q.rating, RATINGS);
        q.demo = clamp(q.demo, DEMOS);
        return q;
    }

    // 탭 규칙: 고른 조건(필터 상태)을 인기·최신 탭에 저장
    ruleKey(popular) {
        return popular ? "mdx_tab_popular" : "mdx_tab_latest";
    }

    ruleSaved(popular) {
        const p = prefs();
        if (!p) return null;
        try {
            const raw = p.getString(this.ruleKey(popular), "");
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    ruleApply(rule, q) {
        const p = prefs();
        if (!p || !rule) return;
        const plain = { lang: q.lang, orig: q.orig, sort: q.sort, status: q.status, rating: q.rating, demo: q.demo, inc: q.inc, exc: q.exc };
        try {
            if (rule === 1) p.setString(this.ruleKey(true), JSON.stringify(plain));
            else if (rule === 2) p.setString(this.ruleKey(false), JSON.stringify(plain));
            else if (rule === 3) p.setString(this.ruleKey(true), "");
            else if (rule === 4) p.setString(this.ruleKey(false), "");
            else if (rule === 5) {
                p.setString(this.ruleKey(true), "");
                p.setString(this.ruleKey(false), "");
            }
        } catch (e) {
            // 저장 실패는 그대로
        }
    }

    ruleText(q) {
        if (!q) return "";
        return [
            LANGS[q.lang] && q.lang ? LANGS[q.lang][0] : null,
            ORIGS[q.orig] && q.orig ? ORIGS[q.orig][0] : null,
            SORTS[q.sort] ? SORTS[q.sort][0] : null,
            q.status ? STATUSES[q.status][0] : null,
            q.demo ? DEMOS[q.demo][0] : null,
            (q.inc || []).length ? `장르 ${(q.inc || []).map((id) => TAG_KO[id] || "?").join("·")}` : null,
        ].filter((x) => x).join(" · ");
    }

    // ================= 목록 =================
    listPath(q, page, title) {
        const p = [`limit=${PAGE}`, `offset=${(page - 1) * PAGE}`, "includes[]=cover_art", "hasAvailableChapters=true"];
        const lang = LANGS[q.lang][1] || chapterLang();
        if (lang !== "*") p.push(`availableTranslatedLanguage[]=${encodeURIComponent(lang)}`);
        for (const o of ORIGS[q.orig][1]) p.push(`originalLanguage[]=${encodeURIComponent(o)}`);
        for (const r of RATINGS[q.rating][1]) p.push(`contentRating[]=${r}`);
        if (STATUSES[q.status][1]) p.push(`status[]=${STATUSES[q.status][1]}`);
        if (DEMOS[q.demo][1]) p.push(`publicationDemographic[]=${DEMOS[q.demo][1]}`);
        for (const id of q.inc || []) p.push(`includedTags[]=${id}`);
        for (const id of q.exc || []) p.push(`excludedTags[]=${id}`);
        let sort = SORTS[q.sort];
        // "검색어와 가까운 순"은 검색어가 있을 때만 (없으면 인기순)
        if (sort[1] === "relevance" && !title) sort = SORTS[1];
        p.push(`order[${sort[1]}]=${sort[2]}`);
        if (title) p.push(`title=${encodeURIComponent(title)}`);
        return "/manga?" + p.join("&");
    }

    async listing(q, page, title) {
        if ((page - 1) * PAGE >= MAX_OFFSET) return { list: [], hasNextPage: false };
        const d = await this.api(this.listPath(q, page, title), "목록");
        const list = (d.data || []).map((m) => ({
            name: titleOf(m.attributes),
            imageUrl: coverOf(m),
            link: "/title/" + m.id,
        }));
        const next = (page * PAGE) < Math.min(Number(d.total) || 0, MAX_OFFSET);
        return { list, hasNextPage: next };
    }

    defaultQ(popular) {
        return { lang: 0, orig: 0, sort: popular ? 1 : 0, status: 0, rating: 0, demo: 0, inc: [], exc: [] };
    }

    async getPopular(page) {
        await notesRefresh(this.client);
        return this.listing(this.ruleSaved(true) || this.defaultQ(true), page, "");
    }

    async getLatestUpdates(page) {
        return this.listing(this.ruleSaved(false) || this.defaultQ(false), page, "");
    }

    async search(query, page, filters) {
        query = String(query || "").trim();
        // 작품 주소(mangadex.org/title/{번호})를 붙여 넣으면 그 작품을 바로
        const m = /mangadex\.org\/(?:title|manga)\/([0-9a-f-]{36})/i.exec(query) || /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(query);
        if (m) {
            const d = await this.getDetail("/title/" + m[1].toLowerCase());
            return { list: [{ name: d.name, imageUrl: d.imageUrl, link: "/title/" + m[1].toLowerCase() }], hasNextPage: false };
        }
        const q = this.readFilters(filters);
        if (!query && q.rule) this.ruleApply(q.rule, q);
        return this.listing(q, page, query);
    }

    // ================= 작품 · 회차 =================
    idOf(url) {
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(url || ""));
        if (!m) throw new Error(`망가덱스 작품 주소가 아니에요 [${String(url).substring(0, 40)}]`);
        return m[1].toLowerCase();
    }

    async getDetail(url) {
        const id = this.idOf(url);
        const d = await this.api(`/manga/${id}?includes[]=author&includes[]=artist&includes[]=cover_art`, "작품");
        const m = d.data;
        const a = m.attributes || {};
        const people = (type) => (m.relationships || []).filter((r) => r.type === type && r.attributes).map((r) => r.attributes.name).filter((x) => x);
        const lang = chapterLang();
        let chapters = await this.chapters(id, lang, "");
        // 빈 화 채우기 (2026-11-10, 사용자 "영어로 빈 화 채우기"): 고른 언어에 없는 화 번호만 다른 언어 회차로 채움
        const fill = String(pref("mdx_fill", "en") || "en");
        let filled = 0;
        if (lang !== "*" && fill !== "off" && fill !== lang) {
            try {
                const have = {};
                for (const c of chapters) have[c._key] = true;
                // 아무 언어로나: 영어를 먼저 채우고, 영어에도 없는 화만 다른 언어로
                let extra = [];
                for (const fl of fill === "*" ? ["en", "*"] : [fill]) {
                    if (fl === lang) continue;
                    const more = (await this.chapters(id, fl, "fill")).filter((c) => c._lang !== lang && !have[c._key]);
                    for (const c of more) have[c._key] = true;
                    extra = extra.concat(more);
                }
                filled = extra.length;
                chapters = chapters.concat(extra);
            } catch (e) {
                // 채우기 실패는 고른 언어 회차만
            }
        }
        chapters.sort((x, y) => (y._n - x._n) || (y._t - x._t));
        chapters = chapters.map((x) => ({ name: x.name, url: x.url, dateUpload: x.dateUpload, scanlator: x.scanlator }));
        const desc = (a.description && (a.description.ko || a.description.en || Object.values(a.description)[0])) || "";
        const langs = (a.availableTranslatedLanguages || []).map((l) => LANG_KO[l] || l);
        const info = [
            `원작 언어: ${LANG_KO[a.originalLanguage] || a.originalLanguage || "?"}`,
            a.year ? `발표: ${a.year}년` : "",
            langs.length ? `번역된 언어: ${langs.join(", ")}` : "",
            a.lastChapter ? `마지막 회차: ${a.lastChapter}화` : "",
        ].filter((x) => x).join("\n");
        const fillName = fill === "*" ? "다른 언어" : (LANG_KO[fill] || fill);
        // 0.0.5 (2026-11-11 사용자 "한국어 회차가 없으면 채우기가 안 먹힘"): 실제로는 회차가 모두 내려간(isUnavailable) 작품 —
        // 망가덱스의 "번역된 언어" 정보는 예전 그대로라 목록에 나옴. 몇 개가 내려갔는지 세어 정확히 안내
        let gone = 0;
        if (!chapters.length) {
            try {
                gone = Number((await this.api(`/manga/${id}/feed?limit=1&includeUnavailable=1&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`, "회차")).total) || 0;
            } catch (e) {
                gone = 0;
            }
        }
        const note = !chapters.length && gone > 0 ? `⚠️ 이 작품은 회차가 모두 내려가(저작권 등) 망가덱스에서 볼 수 있는 회차가 없어요 (내려간 회차 ${gone}개). 다른 확장에서 찾아 보세요.`
            : !chapters.length ? `⚠️ ${LANG_KO[lang] || lang}로 번역된 회차가 없고, ${fill === "off" ? "빈 화 채우기가 꺼져 있어요" : `${fillName}로도 볼 수 있는 회차가 없어요`}. 확장 설정의 "회차 언어"·"빈 화 채우기"를 바꿔 보세요.`
            : filled ? `ℹ️ ${LANG_KO[lang] || lang} 번역이 없는 ${filled}개 화는 ${fillName} 회차로 채웠어요 (번역팀 칸에 "${fill === "*" ? "영어" : fillName} 번역: 팀 이름"처럼 표시).` : "";
        return {
            name: titleOf(a),
            imageUrl: coverOf(m),
            link: `${SITE}/title/${id}`,
            author: people("author").join(", "),
            artist: people("artist").join(", "),
            description: [note, String(desc).replace(/\r/g, "").trim(), info].filter((x) => x).join("\n\n"),
            genre: (a.tags || []).map((t) => TAG_KO[t.id] || (t.attributes && t.attributes.name && t.attributes.name.en)).filter((x) => x),
            status: STATUS_KO[a.status] !== undefined ? STATUS_KO[a.status] : 5,
            chapters,
        };
    }

    /** 회차: 고른 언어만, 같은 화를 여러 번역팀이 올리면 하나만(먼저 나온 것), 최신이 위 */
    async chapters(id, lang, mode) {
        const out = [];
        const seen = {};
        const ratings = "contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic";
        const langQ = lang === "*" ? "" : `&translatedLanguage[]=${encodeURIComponent(lang)}`;
        for (let offset = 0; offset < MAX_OFFSET; offset += 500) {
            const d = await this.api(`/manga/${id}/feed?limit=500&offset=${offset}${langQ}&${ratings}&order[volume]=desc&order[chapter]=desc&includes[]=scanlation_group&includeExternalUrl=0&includeEmptyPages=0&includeFuturePublishAt=0`, "회차");
            for (const c of d.data || []) {
                const a = c.attributes || {};
                if (a.externalUrl || !(Number(a.pages) > 0)) continue;
                const ch = a.chapter === null || a.chapter === undefined || a.chapter === "" ? "" : String(a.chapter);
                const key = ch ? `c${parseFloat(ch)}` : `v${a.volume || ""}|${a.title || c.id}`;
                // 채우기용은 번호 있는 화만 (단편은 같은 것인지 알 수 없음)
                if (seen[key] || (mode === "fill" && !ch)) continue;
                seen[key] = true;
                const group = (c.relationships || []).filter((r) => r.type === "scanlation_group" && r.attributes).map((r) => r.attributes.name).join(", ");
                const title = String(a.title || "").trim();
                let name = ch ? `${ch}화` : (a.volume ? `${a.volume}권 단편` : "단편");
                if (title) name += ` ${title}`;
                const date = a.readableAt || a.publishAt || a.createdAt;
                if (date) name += ` (${mmdd(date)})`;
                out.push({
                    _n: ch ? parseFloat(ch) : -1,
                    _t: date && !isNaN(Date.parse(date)) ? Date.parse(date) : 0,
                    name,
                    url: c.id,
                    dateUpload: date && !isNaN(Date.parse(date)) ? String(Date.parse(date)) : null,
                    _key: key,
                    _lang: a.translatedLanguage,
                    // 0.0.6 (사용자 "lilyfever 번역자인가? 한국어로 통일"): 번역팀 칸을 "번역: 팀", 다른 언어는 "베트남어 번역: 팀"
                    scanlator: (() => {
                        const who = lang === "*" || mode === "fill" ? `${LANG_KO[a.translatedLanguage] || a.translatedLanguage} 번역` : "번역";
                        return group ? `${who}: ${group}` : (who === "번역" ? "" : who);
                    })(),
                });
            }
            if (offset + 500 >= (Number(d.total) || 0)) break;
        }
        return out;
    }

    // ================= 그림 =================
    async getPageList(url) {
        const id = String(url || "").split("/").filter((x) => x).pop();
        // 443번 문을 쓰는 나눔 서버만 (일부 통신망에서 다른 번호 문이 느리거나 막힘)
        const d = await this.api(`/at-home/server/${id}?forcePort443=true`, "그림 서버");
        const ch = d.chapter || {};
        // 0.0.3: 원본 그림(1~2MB)이 휴대폰에서 느려 데이터 절약 그림(약 0.3MB)을 기본으로 (설정 이름을 바꿔 새 기본값이 적용되게)
        const saver = String(pref("mdx_saver2", "true")) !== "false";
        // 그림 서버: 자동(나눔 서버) 또는 망가덱스 본 서버
        const host = String(pref("mdx_host", "auto")) === "main" ? "https://uploads.mangadex.org" : d.baseUrl;
        const files = saver && (ch.dataSaver || []).length ? ch.dataSaver : ch.data || [];
        if (!d.baseUrl || !ch.hash || !files.length) throw new Error(`그림 목록이 비어 있어요 [그림 · 파일 ${files.length}개]`);
        const dir = saver && (ch.dataSaver || []).length ? "data-saver" : "data";
        const pages = files.map((f) => ({ url: `${host}/${dir}/${ch.hash}/${f}`, headers: { "User-Agent": UA } }));
        // 0.0.4 (2026-11-11 사용자 화면 녹화: 다음 장마다 1~1.5초 회색 빈칸): 그림 서버는 처음 요청에 1.2~1.3초(서버가 원본에서 가져옴),
        // 두 번째부터 0.3초 → 회차를 열 때 모든 장을 첫 1바이트만(Range 0-0) 한꺼번에 미리 요청해 서버에 데워 둠(머니툰과 같은 방법).
        // 최대 1초만 기다림(첫 장이 늦어지지 않게, 망가요미엔 clearTimeout 이 없어 표시 값으로 판단)
        try {
            const warm = Promise.all(pages.map((p) => this.client.get(p.url, { "User-Agent": UA, "Range": "bytes=0-0" }).catch(() => null)));
            await Promise.race([warm, new Promise((ok) => setTimeout(() => ok("timeout"), 1000))]);
        } catch (e) {
            // 데우기 실패는 그대로
        }
        return pages;
    }

    // ================= 필터 · 설정 =================
    getFilterList() {
        const sel = (name, arr) => ({
            type_name: "SelectFilter", name, state: 0,
            values: arr.map((x, i) => ({ type_name: "SelectOption", name: Array.isArray(x) ? x[0] : x, value: String(i) })),
        });
        const pop = this.ruleSaved(true);
        const lat = this.ruleSaved(false);
        return notesFilters(NOTE_KEY).concat([
            { type_name: "HeaderFilter", name: `회차 언어(설정): ${LANG_KO[chapterLang()] || chapterLang()} · 작품 주소(mangadex.org/title/…)를 붙여 넣으면 바로 열기` },
            { type_name: "SeparatorFilter" },
            sel(F_LANG, LANGS),
            sel(F_ORIG, ORIGS),
            sel(F_SORT, SORTS),
            sel(F_STATUS, STATUSES),
            sel(F_RATING, RATINGS),
            sel(F_DEMO, DEMOS),
            {
                type_name: "GroupFilter", name: F_GENRE,
                state: TAGS.map((t) => ({ type_name: "TriState", name: t[1], value: t[0], state: 0 })),
            },
            { type_name: "SeparatorFilter" },
            { type_name: "HeaderFilter", name: `현재 인기: ${pop ? this.ruleText(pop) : "인기 (팔로우 많은 순) (기본)"}` },
            { type_name: "HeaderFilter", name: `현재 최신: ${lat ? this.ruleText(lat) : "최근 업데이트 (기본)"}` },
            sel(F_RULE, RULES),
        ]);
    }

    getSourcePreferences() {
        return [{
            key: "mdx_lang",
            listPreference: {
                title: "회차 언어",
                summary: "작품을 열었을 때 보여 줄 회차의 언어 (목록의 번역 언어 필터 기본값도 이 언어)",
                valueIndex: 0,
                entries: LANGS.slice(1).map((x) => x[0]),
                entryValues: LANGS.slice(1).map((x) => x[1]),
            },
        }, {
            key: "mdx_fill",
            listPreference: {
                title: "빈 화 채우기",
                summary: "회차 언어로 번역되지 않은 화를 다른 언어 회차로 채움 (번역팀 칸에 \"영어 번역: 팀\" 처럼 표시, 아무 언어로나는 영어 먼저)",
                valueIndex: 0,
                entries: ["영어로 채우기", "아무 언어로나 채우기 (영어 먼저)", "채우지 않기"],
                entryValues: ["en", "*", "off"],
            },
        }, {
            key: "mdx_saver2",
            switchPreferenceCompat: {
                title: "데이터 절약 그림 (기본 켬)",
                summary: "그림을 작은 크기로 받아 빨리 뜸 (약 0.3MB, 끄면 원본 1~2MB · 화질 좋음 · 느림)",
                value: true,
            },
        }, {
            key: "mdx_host",
            listPreference: {
                title: "그림 서버",
                summary: "그림이 느리면 바꿔 보세요 (자동 = 망가덱스가 골라 주는 나눔 서버)",
                valueIndex: 0,
                entries: ["자동 (나눔 서버)", "망가덱스 본 서버"],
                entryValues: ["auto", "main"],
            },
        }];
    }
}

// ---------- 업데이트 내역 (필터 맨 위 📝 줄) — 웹툰 확장들과 같은 코드 ----------
const NOTES_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-manga-extensions/main/changelog.json";

async function notesRefresh(client) {
    let p;
    try {
        p = new SharedPreferences();
    } catch (e) {
        return;
    }
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

function notesFilters(key) {
    let list = [];
    try {
        list = (JSON.parse(new SharedPreferences().getString("notes_json", "") || "{}").items || {})[key] || [];
    } catch (e) {
        list = [];
    }
    const mine = String(mangayomiSources[0].version || "");
    const n = list.filter((x) => x && x.t)[0];
    const last = n ? ` · ${String(n.d || "").substring(5).replace("-", ".")} ${String(n.t).replace(/^망가요미:\s*/, "")}` : "";
    return [{ type_name: "HeaderFilter", name: `📝 ${mine}${last}` }];
}

// ---------- 필터 맨 끝 빈 줄 (2026-11-03, 웹툰 확장들과 같음) ----------
(function () {
    const base = DefaultExtension.prototype.getFilterList;
    DefaultExtension.prototype.getFilterList = function () {
        const list = base.apply(this, arguments) || [];
        return list.concat([1, 2, 3].map(() => ({ type_name: "HeaderFilter", name: "　" })));
    };
})();

// ---------- 회차 번호 겹침 막기 (2026-11-07 회차 점검, 웹툰 확장들과 같은 코드) ----------
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
        if (ok(list, title) && ok(list, "")) return d;
        let last = 0;
        const fmt = (v) => String(Math.round(v * 100) / 100);
        for (let i = list.length - 1; i >= 0; i--) {
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
