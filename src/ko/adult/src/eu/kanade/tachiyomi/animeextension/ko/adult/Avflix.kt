package eu.kanade.tachiyomi.animeextension.ko.adult

import android.app.Application
import android.content.SharedPreferences
import android.util.Base64
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimeUpdateStrategy
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import rx.Observable
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * AVFLIX (kr5.avflix.co, 2026-11-09, 망가요미판 my-ext avflix.js 0.0.1 과 같은 규칙, 해외에서 열려 구조 확인).
 * Next.js 사이트: 화면 데이터는 self.__next_f.push([1,"…"]) 조각. 카드 {"idx","title","thumbnail","mosaic","subtitle",…,"regDate","releaseDate"},
 * 쪽 정보 "paging":{pageNo,…,finalPageNo}. 목록 /category/{code}?q=…, 검색 /search/{검색어}?q=… —
 * q 는 사이트 코드 그대로 base64(encodeURIComponent(JSON {pageNo, sort, subtitle:"all", mosaic:"all"})).
 * 작품 /av/{idx}: 화면 데이터의 "videoUrl"(mp4, 사이트 Referer 필요) · 그림도 Referer 필요.
 */
class Avflix : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "AVFLIX"
    override val lang = "ko"
    override val supportsLatest = true

    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    override val baseUrl: String
        get() {
            val p = prefs()
            var v = p?.getString(PREF_DOMAIN, "")?.trim()?.trimEnd('/').orEmpty()
            if (v.isNotEmpty() && !v.startsWith("http")) v = "https://$v"
            if (DOMAIN_REGEX.matches(v)) return v
            val auto = p?.getString(PREF_AUTO_DOMAIN, "")?.trim().orEmpty()
            return if (DOMAIN_REGEX.matches(auto)) auto else DEFAULT_BASE_URL
        }

    override val client: OkHttpClient = network.client.newBuilder()
        .apply { interceptors().add(0, FriendlyNet) }
        .addInterceptor { chain -> domainIntercept(chain) }
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 주소 자동 찾기 =================
    // 지금 주소가 안 열리면(연결 실패·5xx·403 등·화면 데이터 없음) 앞 글자 번호 +1~+5, -1~-2 (kr5 → kr6 …)
    private fun domainIntercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val baseHost = baseUrl.toHttpUrlOrNull()?.host
        if (baseHost == null || req.url.host != baseHost || req.method != "GET") return chain.proceed(req)
        fun retryOn(found: String): Response {
            prefs()?.edit()?.putString(PREF_AUTO_DOMAIN, "https://$found")?.apply()
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(found).build()).build())
        }
        val res = try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            val found = discover(baseHost) ?: throw e
            return retryOn(found)
        }
        val broken = res.code >= 500 || (res.code in 400..499 && res.code != 404) ||
            (res.code == 200 && !res.peekBody(3_000_000).string().contains("__next_f"))
        if (broken) {
            val found = discover(baseHost) ?: return res
            res.close()
            return retryOn(found)
        }
        return res
    }

    private val plain by lazy {
        OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).callTimeout(10, TimeUnit.SECONDS).build()
    }

    /** 진짜 AVFLIX 화면인지 (사이트 코드 avflix 가 화면 데이터에 있음) */
    private fun isSite(host: String): Boolean = runCatching {
        plain.newCall(GET("https://$host/", Headers.headersOf("Referer", "https://$host/"))).execute().use { res ->
            res.code < 400 && SITE_CODE.containsMatchIn(res.body.string())
        }
    }.getOrDefault(false)

    @Volatile private var lastDiscover = 0L

    private fun discover(currentHost: String): String? = synchronized(LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now
        val m = HOST_PARTS.find(currentHost) ?: return null
        val n = m.groupValues[2].toInt()
        listOf(1, 2, 3, 4, 5, -1, -2).filter { n + it >= 1 }.map { "${m.groupValues[1]}${n + it}.${m.groupValues[3]}" }
            .firstOrNull { it != currentHost && isSite(it) }
    }

    // ================= 목록 =================
    private fun ruleSizes() = intArrayOf(CATS.size, SORTS.size)

    /** 사이트의 쪽·정렬 값 (사이트 화면 코드와 같은 방법) */
    private fun pageQuery(page: Int, sort: String): String {
        val json = """{"pageNo":$page,"sort":"$sort","subtitle":"all","mosaic":"all"}"""
        val enc = URLEncoder.encode(json, "UTF-8").replace("+", "%20")
        val b64 = Base64.encodeToString(enc.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        return URLEncoder.encode(b64, "UTF-8")
    }

    private fun listUrl(idx: IntArray, page: Int) = "$baseUrl/category/${CATS[idx[0]].second}?q=${pageQuery(page, SORTS[idx[1]].second)}"

    override fun popularAnimeRequest(page: Int): Request = GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request = GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    // 사이트 주소를 붙여 넣으면 그 주소로 바꾸고, 작품·분류 주소면 그 화면 (https:// 없어도)
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val site = PASTE_REGEX.find(query.trim()) ?: return super.fetchSearchAnime(page, query, filters)
        val host = site.groupValues[1].lowercase()
        val path = site.groupValues[2].substringBefore('?').substringBefore('#')
        return Observable.fromCallable {
            if ("https://$host" != baseUrl) {
                if (!isSite(host)) throw Exception("$host 는 AVFLIX 화면이 아니에요. 주소를 다시 확인해 주세요.")
                prefs()?.edit()?.putString(PREF_AUTO_DOMAIN, "https://$host")?.apply()
            }
        }.flatMap<AnimesPage> {
            if (AV_PATH.containsMatchIn(path) || CAT_PATH.containsMatchIn(path)) {
                super.fetchSearchAnime(page, "$baseUrl$path", filters)
            } else {
                fetchPopularAnime(page)
            }
        }
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        if (q.startsWith(baseUrl)) {
            val path = q.removePrefix(baseUrl)
            AV_PATH.find(path)?.let { return GET("$baseUrl/av/${it.groupValues[1]}", h()) }
            CAT_PATH.find(path)?.let { return GET("$baseUrl/category/${it.groupValues[1]}?q=${pageQuery(page, "reg_date")}", h()) }
        }
        val idx = intArrayOf(
            filters.filterIsInstance<CatFilter>().firstOrNull()?.state ?: 0,
            filters.filterIsInstance<SortFilter>().firstOrNull()?.state ?: 0,
        )
        if (q.isNotEmpty()) {
            val enc = URLEncoder.encode(q, "UTF-8").replace("+", "%20")
            return GET("$baseUrl/search/$enc?q=${pageQuery(page, SORTS[idx[1]].second)}", h())
        }
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        if (response.request.url.encodedPath.startsWith("/av/")) {
            val d = animeDetailsParse(response)
            return AnimesPage(listOf(d.apply { url = response.request.url.encodedPath }), false)
        }
        return parseList(response)
    }

    /** 화면 데이터 조각(self.__next_f.push([1,"…"]))을 하나로. 정규식 대신 한 글자씩 읽음(긴 글자에서 자바 정규식이 넘침) */
    private fun flight(html: String): String {
        val sb = StringBuilder()
        val mark = "self.__next_f.push([1,\""
        var at = html.indexOf(mark)
        while (at >= 0) {
            val start = at + mark.length
            var i = start
            while (i < html.length) {
                val c = html[i]
                if (c == '\\') {
                    i += 2
                    continue
                }
                if (c == '"') break
                i++
            }
            if (i >= html.length) break
            runCatching { sb.append(JSONArray("[\"" + html.substring(start, i) + "\"]").getString(0)) }
            at = html.indexOf(mark, i)
        }
        return sb.toString()
    }

    private fun cards(data: String): List<JSONObject> {
        val seen = HashSet<Long>()
        return CARD_REGEX.findAll(data).mapNotNull { m ->
            val o = runCatching { JSONObject(m.value) }.getOrNull() ?: return@mapNotNull null
            val idx = o.optLong("idx")
            if (idx == 0L || o.optString("title").isEmpty() || !seen.add(idx)) null else o
        }.toList()
    }

    private fun parseList(response: Response): AnimesPage {
        val data = flight(response.body.string())
        val animes = cards(data).map { o ->
            val title = o.optString("title").trim()
            val tags = listOfNotNull(
                if (o.optBoolean("subtitle")) "자막" else null,
                if (o.has("mosaic") && !o.optBoolean("mosaic", true)) "노모" else null,
            )
            val date = o.optString("releaseDate").ifEmpty { o.optString("regDate") }.take(10)
            SAnime.create().apply {
                url = "/av/${o.optLong("idx")}" + if (YMD_PARTS.matches(date)) "#d=$date" else ""
                this.title = title + if (tags.isNotEmpty() && !Regex("REMOVE|자막").containsMatchIn(title)) " [${tags.joinToString("·")}]" else ""
                thumbnail_url = o.optString("thumbnail").ifEmpty { null }
            }
        }
        val pg = PAGING_REGEX.find(data)
        return AnimesPage(animes, pg != null && pg.groupValues[1].toInt() < pg.groupValues[2].toInt())
    }

    // ================= 작품 정보 =================
    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url.substringBefore('#')

    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    private fun dateMs(response: Response): Pair<Long, String?> {
        val d = response.request.url.fragment?.removePrefix("d=").orEmpty()
        val m = YMD_PARTS.find(d) ?: return 0L to null
        val ms = Calendar.getInstance(KST).apply {
            clear()
            set(m.groupValues[1].toInt(), m.groupValues[2].toInt() - 1, m.groupValues[3].toInt())
        }.timeInMillis
        return ms to m.groupValues[1]
    }

    override fun animeDetailsParse(response: Response): SAnime {
        val (ms, year) = dateMs(response)
        val html = response.body.string()
        val data = flight(html)
        val doc = Jsoup.parse(html, response.request.url.toString())
        fun meta(p: String) = (doc.selectFirst("meta[property=$p]") ?: doc.selectFirst("meta[name=$p]"))?.attr("content")?.trim().orEmpty()
        val name = meta("og:title").ifEmpty { doc.title().trim().trimEnd('|').trim() }
        // 작품 정보 칸의 글자들 ("출연진" 다음 글자 = 출연 배우 등)
        val texts = mutableListOf<String>()
        val at = data.indexOf("\"avIdx\":")
        if (at >= 0) {
            for (m in CHILDREN_REGEX.findAll(data, at)) {
                if (texts.size >= 60 || m.range.first > at + 20_000) break
                texts.add(m.groupValues[1])
            }
        }
        fun after(label: String) = texts.indexOf(label).let { i -> if (i >= 0 && i + 1 < texts.size) texts[i + 1] else "" }
        val length = texts.firstOrNull { LENGTH_REGEX.matches(it) }.orEmpty()
        val cast = after("출연진")
        val maker = after("제작사")
        val label = after("레이블")
        val keywords = meta("keywords").split(",").map { it.trim() }.filter { it.isNotEmpty() && it != name && it.length < 30 }
        val info = listOfNotNull(
            length.ifEmpty { null }?.let { "길이 $it" },
            if (ms > 0) "출시일 ${ymd(ms)}" else null,
            cast.ifEmpty { null }?.let { "출연 $it" },
            maker.ifEmpty { null }?.let { "제작사 $it" },
            label.takeIf { it.isNotEmpty() && it != "감독" }?.let { "레이블 $it" },
        ).joinToString(" · ")
        return SAnime.create().apply {
            title = if (year != null && name.isNotEmpty() && !TITLE_YEAR.containsMatchIn(name)) "$name ($year)" else name
            thumbnail_url = meta("og:image").ifEmpty { null }
            author = maker.ifEmpty { null }
            artist = cast.ifEmpty { null }
            genre = keywords.drop(1).joinToString(", ").ifEmpty { null }
            status = SAnime.COMPLETED
            update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            description = listOf(info, meta("description")).filter { it.isNotEmpty() }.joinToString("\n\n")
        }
    }

    // ================= 회차 (영화처럼 하나: "본편") =================
    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun episodeListParse(response: Response): List<SEpisode> {
        val (ms, _) = dateMs(response)
        return listOf(
            SEpisode.create().apply {
                url = response.request.url.encodedPath
                name = if (ms > 0) "본편 (${ymd(ms)})" else "본편"
                episode_number = 1f
                date_upload = ms
            },
        )
    }

    private fun ymd(ms: Long) = synchronized(YMD_FMT) { YMD_FMT.format(java.util.Date(ms)) }

    // ================= 재생 =================
    override fun videoListRequest(episode: SEpisode): Request = GET(baseUrl + episode.url.substringBefore('#'), h())

    override fun videoListParse(response: Response): List<Video> {
        val data = flight(response.body.string())
        val headers = Headers.Builder().set("Referer", "$baseUrl/").set("Origin", baseUrl).build()
        val out = mutableListOf<Video>()
        for (m in VIDEO_URL_REGEX.findAll(data)) {
            val v = m.groupValues[1]
            if (out.any { it.url == v }) continue
            if (v.contains(".m3u8")) {
                out.addAll(HlsQuality.expand(client, v, LABEL, headers))
            } else {
                out.add(Video(v, HlsQuality.withRes(if (out.isEmpty()) LABEL else "$LABEL (대체 ${out.size})", v), v, headers))
            }
        }
        if (out.isEmpty()) throw Exception("영상 주소를 못 찾았어요 [작품 화면에 videoUrl 없음 · 로그인이 필요한 작품일 수 있어요]")
        return HlsQuality.sort(prefs(), out)
    }

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("avflix", baseFilters())

    private fun ruleText(i: IntArray) = "${CATS[i[0]].first} · ${SORTS[i[1]].first}"

    private fun baseFilters(): AnimeFilterList = AnimeFilterList(
        listOf(
            AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}"),
            AnimeFilter.Header("검색창에 사이트 주소를 붙여 넣으면 그 주소로 바꾸고, 작품·분류 주소면 그 화면을 열어요"),
            AnimeFilter.Separator(),
            AnimeFilter.Header("검색어가 있으면 정렬만 적용"),
            CatFilter(),
            SortFilter(),
        ) + TabRule.filters(prefs(), ruleSizes(), ruleText(DEFAULT_POPULAR) to ruleText(DEFAULT_LATEST), ::ruleText),
    )

    class CatFilter : AnimeFilter.Select<String>("분류", CATS.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN
            title = "사이트 주소 직접 지정 (선택)"
            summary = "비워 두면 $DEFAULT_BASE_URL (안 열리면 kr6·kr7… 를 자동으로 찾아요)\n현재 주소: $baseUrl"
            dialogMessage = "https:// 로 시작하는 주소 (또는 검색창에 붙여 넣기)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                var input = (newValue as String).trim().trimEnd('/')
                if (input.isNotEmpty() && !input.startsWith("http")) input = "https://$input"
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: $DEFAULT_BASE_URL)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)
        HlsQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_domain_key_auto"
        private const val DEFAULT_BASE_URL = "https://kr5.avflix.co"
        private const val LABEL = "AVFLIX"
        private val LOCK = Any()

        private val DOMAIN_REGEX = Regex("""^https://(?:[a-z]+\d*\.)?avflix\.[a-z]{2,8}$""")
        private val HOST_PARTS = Regex("""^([a-z]+)(\d+)\.(avflix\.[a-z]{2,8})$""")
        private val PASTE_REGEX = Regex("""^(?:https?://)?((?:[a-z]+\d*\.)?avflix\.[a-z]{2,8})(/\S*)?$""", RegexOption.IGNORE_CASE)
        private val SITE_CODE = Regex("""\\?"code\\?":\\?"avflix\\?"""")
        private val AV_PATH = Regex("""^/av/(\d+)""")
        private val CAT_PATH = Regex("""^/category/([a-z0-9_]+)""")
        private val CARD_REGEX = Regex("""\{"idx":\d+,"title":[^{}]*?"regDate":[^{}]*\}""")
        private val PAGING_REGEX = Regex(""""paging":\{"pageNo":(\d+)[^}]*?"finalPageNo":(\d+)""")
        private val CHILDREN_REGEX = Regex(""""children":"([^"$][^"]{0,200})"""")
        private val VIDEO_URL_REGEX = Regex(""""videoUrl":"(https?:[^"]+)"""")
        private val LENGTH_REGEX = Regex("""^\d+시간(?: \d+분)?$|^\d+분$""")
        private val YMD_PARTS = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")
        private val TITLE_YEAR = Regex("""\(\d{4}\)$""")
        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val YMD_FMT = SimpleDateFormat("yyyy.MM.dd", Locale.KOREA).apply { timeZone = KST }

        // 분류 (사이트 메뉴 그대로, 2026-10-29)
        private val CATS = listOf(
            "일본 AV 전체" to "japanese", "노모" to "nomosaic", "노모 (자막)" to "nomosaic_sub", "유모" to "recent", "클래식" to "classic",
            "2026년 신작 (노모)" to "nomosaic2026", "2026년 신작 (유모)" to "mosaic2026", "아시아/기타" to "asia", "SM" to "sm",
        )
        private val SORTS = listOf("등록일순" to "reg_date", "출시일순" to "release_date", "조회수순" to "view_count")

        private val DEFAULT_POPULAR = intArrayOf(0, 2)
        private val DEFAULT_LATEST = intArrayOf(0, 0)
    }
}
