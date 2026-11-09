package eu.kanade.tachiyomi.animeextension.ko.adult

import android.app.Application
import android.content.SharedPreferences
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * xHamster (xhamster1.desi, 2026-11-09, 망가요미판 my-ext xhamster.js 0.0.6 과 같은 규칙, 해외에서 열려 구조 확인).
 * 목록·검색·작품 정보는 화면 안의 window.initials JSON (videoThumbProps: title·pageURL·thumbURL·duration·created).
 * 목록 주소: [/gay|/shemale] + [/categories/{slug} + [/hd|/4k] | [/hd|/4k]] + [정렬] + [/쪽], 검색 /search/{q}?page=N[&sort=].
 * 영상: 화면 head 의 <link rel="preload" href="…_TPL_.h264.mp4.m3u8">(화질 묶음) · <video src="….mp4">, 없으면 숨은 WebView.
 * 암호처럼 된 xplayerSettings.sources 는 풀지 않음.
 */
class XHamster : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "xHamster"
    override val lang = "ko"
    override val supportsLatest = true

    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    // 주소: 설정에 직접 넣은 주소 → 자동으로 찾은(또는 붙여 넣은) 주소 → 기본 주소
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
    // 지금 주소가 안 열리면(연결 실패·5xx·403 등·화면에 window.initials 없음) 같은 이름의 번호 주소(+1~+5, -1~-2)와 번호 없는 주소를 확인
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
            (res.code == 200 && !res.peekBody(2_000_000).string().contains("window.initials"))
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

    /** 진짜 xHamster 화면인지 (영상 카드 JSON 이 있음) */
    private fun isSite(host: String): Boolean = runCatching {
        plain.newCall(GET("https://$host/newest", Headers.headersOf("Referer", "https://$host/"))).execute().use { res ->
            val body = res.body.string()
            res.code < 400 && body.contains("window.initials") && body.contains("xhamster", true)
        }
    }.getOrDefault(false)

    @Volatile private var lastDiscover = 0L

    private fun discover(currentHost: String): String? = synchronized(LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now
        val m = HOST_PARTS.find(currentHost) ?: return null
        val n = m.groupValues[2].toIntOrNull() ?: 0
        val cands = listOf(1, 2, 3, 4, 5, -1, -2).filter { n + it >= 1 }.map { "${m.groupValues[1]}${n + it}${m.groupValues[3]}" } +
            listOfNotNull(if (m.groupValues[2].isNotEmpty()) "${m.groupValues[1]}${m.groupValues[3]}" else null)
        cands.firstOrNull { it != currentHost && isSite(it) }
    }

    // ================= 목록 =================
    private fun ruleSizes() = FILTER_DEFS.map { it.second.size }.toIntArray()

    private fun listUrl(idx: IntArray, page: Int): String {
        val cat = (3 until FILTER_DEFS.size).firstOrNull { idx[it] > 0 }?.let { FILTER_DEFS[it].second[idx[it]].second }
        val fmt = FORMATS[idx[1]].second
        var path = ORIENTS[idx[0]].second + (if (cat != null) "/categories/$cat$fmt" else fmt) + SORTS[idx[2]].second
        if (page > 1) path += "/$page"
        return baseUrl + path.ifEmpty { "/" }
    }

    override fun popularAnimeRequest(page: Int): Request = GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: defaultPopular(), page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request = GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: defaultLatest(), page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    // 사이트 주소를 붙여 넣으면 그 주소로 바꾸고, 영상·목록 주소면 그 화면 (https:// 없어도)
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val site = PASTE_REGEX.find(query.trim()) ?: return super.fetchSearchAnime(page, query, filters)
        val host = site.groupValues[1].lowercase()
        val path = site.groupValues[2].ifEmpty { "/" }
        return Observable.fromCallable {
            if ("https://$host" != baseUrl) {
                if (!isSite(host)) throw Exception("$host 는 xHamster 화면이 아니에요. 주소를 다시 확인해 주세요.")
                prefs()?.edit()?.putString(PREF_AUTO_DOMAIN, "https://$host")?.apply()
            }
        }.flatMap<AnimesPage> {
            if (path == "/") fetchPopularAnime(page) else super.fetchSearchAnime(page, "$baseUrl$path", filters)
        }
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        if (q.startsWith(baseUrl)) {
            val path = q.removePrefix(baseUrl).substringBefore('#')
            if (path.startsWith("/videos/")) return GET(baseUrl + path, h())
            val base = baseUrl + path.replace(Regex("""/\d+$"""), "").trimEnd('/')
            val url = if (base.contains('?')) "$base&page=$page" else if (page > 1) "$base/$page" else base
            return GET(url, h())
        }
        val idx = IntArray(FILTER_DEFS.size)
        filters.filterIsInstance<DefFilter>().forEach { f -> idx[f.index] = f.state }
        if (q.isNotEmpty()) {
            var url = "$baseUrl/search/${URLEncoder.encode(q, "UTF-8").replace("+", "%20")}?page=$page"
            SEARCH_SORTS[SORTS[idx[2]].second]?.let { url += "&sort=$it" }
            return GET(url, h())
        }
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        if (response.request.url.encodedPath.startsWith("/videos/")) {
            val d = animeDetailsParse(response)
            return AnimesPage(listOf(d.apply { url = response.request.url.encodedPath }), false)
        }
        return parseList(response)
    }

    /** 화면 안의 window.initials JSON */
    private fun initials(html: String): JSONObject? {
        val i = html.indexOf("window.initials=")
        if (i < 0) return null
        val j = html.indexOf("</script>", i).let { if (it < 0) html.length else it }
        return runCatching { JSONObject(html.substring(i + 16, j).trim().trimEnd(';')) }.getOrNull()
    }

    /** JSON 안의 영상 카드 목록 중 가장 큰 것 (목록 videoListProps·검색 searchResult 등) */
    private fun thumbList(root: Any?): JSONArray {
        var best = JSONArray()
        fun walk(x: Any?, depth: Int) {
            if (x == null || depth > 8) return
            when (x) {
                is JSONArray -> {
                    val f = x.optJSONObject(0)
                    if (f != null && f.has("pageURL") && f.has("duration") && x.length() > best.length()) best = x
                    for (k in 0 until minOf(5, x.length())) walk(x.opt(k), depth + 1)
                }
                is JSONObject -> x.keys().forEach { walk(x.opt(it), depth + 1) }
            }
        }
        walk(root, 0)
        return best
    }

    /** 마지막 쪽 번호 (paginationProps.lastPageNumber · pagination.maxPage) */
    private fun lastPage(root: Any?): Int {
        var n = 0
        fun walk(x: Any?, depth: Int) {
            if (x == null || depth > 6) return
            when (x) {
                is JSONObject -> {
                    (x.opt("lastPageNumber") as? Number)?.let { n = maxOf(n, it.toInt()) }
                    if (x.has("pageLinkTemplate")) (x.opt("maxPage") as? Number)?.let { n = maxOf(n, it.toInt()) }
                    x.keys().forEach { walk(x.opt(it), depth + 1) }
                }
                is JSONArray -> for (k in 0 until x.length()) walk(x.opt(k), depth + 1)
            }
        }
        walk(root, 0)
        return n
    }

    private fun parseList(response: Response): AnimesPage {
        val data = initials(response.body.string()) ?: throw Exception("xHamster 목록을 읽지 못했어요 (화면 모양이 바뀐 것 같아요)")
        val page = PAGE_TAIL.find(response.request.url.encodedPath)?.groupValues?.get(1)?.toIntOrNull()
            ?: response.request.url.queryParameter("page")?.toIntOrNull() ?: 1
        val arr = thumbList(data)
        val animes = (0 until arr.length()).mapNotNull { k ->
            val v = arr.optJSONObject(k) ?: return@mapNotNull null
            val pageUrl = v.optString("pageURL")
            val path = pageUrl.toHttpUrlOrNull()?.encodedPath ?: return@mapNotNull null
            if (!path.startsWith("/videos/")) return@mapNotNull null
            val created = v.optLong("created", 0L)
            SAnime.create().apply {
                url = path + if (created > 0) "#c=$created" else ""
                title = v.optString("title").trim()
                thumbnail_url = v.optString("thumbURL").ifEmpty { v.optString("imageURL") }.ifEmpty { null }
            }
        }
        val last = lastPage(data)
        return AnimesPage(animes, animes.isNotEmpty() && (if (last > 0) page < last else animes.size >= 20))
    }

    // ================= 작품 정보 =================
    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url.substringBefore('#')

    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun animeDetailsParse(response: Response): SAnime {
        val created = CREATED_FRAG.find(response.request.url.fragment?.let { "#$it" }.orEmpty())?.groupValues?.get(1)?.toLongOrNull() ?: 0L
        val html = response.body.string()
        val data = initials(html) ?: JSONObject()
        val ve = data.optJSONObject("videoEntity") ?: JSONObject()
        val vm = data.optJSONObject("videoModel") ?: JSONObject()
        val doc = Jsoup.parse(html, response.request.url.toString())
        val name = ve.optString("title").ifEmpty { doc.selectFirst("h1")?.text().orEmpty() }.trim()
        val tagsArr = data.optJSONObject("videoTagsComponent")?.optJSONArray("tags") ?: JSONArray()
        val tags = (0 until tagsArr.length()).mapNotNull { tagsArr.optJSONObject(it)?.optString("name")?.trim()?.ifEmpty { null } }
        val author = vm.optJSONObject("channelModel")?.optString("channelName")?.ifEmpty { null }
            ?: vm.optJSONObject("author")?.optString("name")?.ifEmpty { null }
        val ms = created * 1000
        val r = ve.optJSONObject("rating")
        val info = listOfNotNull(
            ve.optLong("duration").takeIf { it > 0 }?.let { "길이 ${hms(it)}" },
            ve.optString("maxResolution").ifEmpty { null }?.let { "최대 $it" },
            ve.optLong("views").takeIf { it > 0 }?.let { "조회 ${count(it)}" },
            r?.takeIf { it.has("likes") }?.let { "👍 ${count(it.optLong("likes"))} · 👎 ${count(it.optLong("dislikes"))}" },
            if (ms > 0) "올린 날 ${ymd(ms)}" else ve.optString("dateAgo").ifEmpty { null },
        ).joinToString(" · ")
        return SAnime.create().apply {
            title = if (ms > 0 && name.isNotEmpty() && !TITLE_YEAR.containsMatchIn(name)) "$name (${ymd(ms).take(4)})" else name
            val og = doc.selectFirst("meta[property=og:image]")?.attr("content")
            thumbnail_url = ve.optString("thumbBig").ifEmpty { og?.takeIf { !it.contains("16x9") } }
            this.author = author
            genre = tags.joinToString(", ").ifEmpty { null }
            status = SAnime.COMPLETED
            update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            description = listOf(info, ve.optString("description").trim()).filter { it.isNotEmpty() }.joinToString("\n\n")
        }
    }

    // ================= 회차 (영화처럼 하나: "본편") =================
    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun episodeListParse(response: Response): List<SEpisode> {
        val created = CREATED_FRAG.find(response.request.url.fragment?.let { "#$it" }.orEmpty())?.groupValues?.get(1)?.toLongOrNull() ?: 0L
        val ms = created * 1000
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

    private fun hms(sec: Long): String {
        val hh = sec / 3600
        val mm = (sec % 3600) / 60
        val ss = sec % 60
        return (if (hh > 0) "$hh:%02d".format(mm) else "$mm") + ":%02d".format(ss)
    }

    private fun count(n: Long): String = when {
        n >= 1_000_000 -> "%.1fM".format(Locale.US, n / 1e6)
        n >= 1_000 -> "%.1fK".format(Locale.US, n / 1e3)
        else -> n.toString()
    }

    // ================= 재생 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val url = baseUrl + episode.url.substringBefore('#')
        val origin = baseUrl
        val headers = Headers.Builder().set("Referer", "$origin/").set("Origin", origin).build()
        val out = mutableListOf<Video>()
        val html = runCatching { client.newCall(GET(url, h())).execute().use { it.body.string() } }.getOrDefault("")
        PRELOAD_REGEX.find(html)?.groupValues?.get(1)?.let { out.addAll(fromHls(unesc(it), headers, "")) }
        VIDEO_SRC_REGEX.find(html)?.groupValues?.get(1)?.let { mp4 ->
            val u = unesc(mp4)
            out.add(Video(u, HlsQuality.withRes("$LABEL 기본", u), u, headers))
        }
        if (out.isEmpty()) {
            // 화면에 주소가 없으면 숨은 WebView 로 열어 플레이어가 불러온 m3u8
            val r = WebSniff.m3u8(url, "$origin/", h()["User-Agent"], 20)
            r.hits.firstOrNull()?.let { out.addAll(fromHls(it.url, headers, " (웹뷰)")) }
        }
        if (out.isEmpty()) throw Exception("영상 주소를 못 찾았어요 [화면에 영상 주소 없음 · 웹뷰에서도 못 찾음]")
        HlsQuality.sort(prefs(), out)
    }

    private fun unesc(s: String) = s.replace("&amp;", "&").replace("\\/", "/")

    /** 화질 묶음 목록(m3u8) → H.264(자동+화질별) + AV1, 144p 는 뺌 */
    private fun fromHls(m3u8: String, headers: Headers, tag: String): List<Video> {
        if (!m3u8.contains(".m3u8")) return listOf(Video(m3u8, HlsQuality.withRes(LABEL + tag, m3u8), m3u8, headers))
        val h264 = m3u8.replace(".av1.mp4.m3u8", ".h264.mp4.m3u8")
        val out = mutableListOf<Video>()
        if (h264 != m3u8) {
            val hs = HlsQuality.expand(client, h264, "$LABEL$tag H.264", headers)
            if (hs.size > 1) out.addAll(hs.filterNot { it.quality.endsWith(" 144p") })
        }
        val a = HlsQuality.expand(client, m3u8, if (m3u8.contains(".av1.")) "$LABEL$tag AV1" else LABEL + tag, headers)
        out.addAll(if (out.isNotEmpty()) a.take(1) else a.filterNot { it.quality.endsWith(" 144p") })
        return out
    }

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("xhamster", baseFilters())

    private fun ruleText(i: IntArray): String = FILTER_DEFS.indices.filter { it == 2 || i[it] > 0 }
        .joinToString(" · ") { FILTER_DEFS[it].second[i[it]].first }

    private fun baseFilters(): AnimeFilterList = AnimeFilterList(
        listOf<AnimeFilter<*>>(
            AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}"),
            AnimeFilter.Header("검색창에 사이트 주소를 붙여 넣으면 그 주소로 바꾸고, 영상·목록 주소면 그 화면을 열어요"),
            AnimeFilter.Separator(),
            AnimeFilter.Header("검색어가 있으면 정렬(최신·조회)만 적용 · 카테고리는 위에서부터 처음 고른 하나만"),
        ) + FILTER_DEFS.mapIndexed { i, d -> DefFilter(i, d.first, d.second.map { it.first }.toTypedArray()) } +
            TabRule.filters(prefs(), ruleSizes(), ruleText(defaultPopular()) to ruleText(defaultLatest()), ::ruleText),
    )

    class DefFilter(val index: Int, name: String, values: Array<String>) : AnimeFilter.Select<String>(name, values)

    // ================= 설정 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN
            title = "사이트 주소 직접 지정 (선택)"
            summary = "비워 두면 $DEFAULT_BASE_URL (안 열리면 번호 주소를 자동으로 찾아요)\n현재 주소: $baseUrl"
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

    private fun defaultPopular() = IntArray(FILTER_DEFS.size) { if (it == 2) 3 else 0 }

    private fun defaultLatest() = IntArray(FILTER_DEFS.size) { if (it == 2) 1 else 0 }

    companion object {
        private const val PREF_DOMAIN = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_domain_key_auto"
        private const val DEFAULT_BASE_URL = "https://xhamster1.desi"
        private const val LABEL = "xHamster"
        private val LOCK = Any()

        private val DOMAIN_REGEX = Regex("""^https://(?:[a-z]{2}\.)?xhamster\d*\.[a-z]{2,8}$""")
        private val HOST_PARTS = Regex("""^((?:[a-z]{2}\.)?xhamster)(\d*)(\.[a-z]{2,8})$""")
        private val PASTE_REGEX = Regex("""^(?:https?://)?((?:[a-z]{2}\.)?xhamster\d*\.[a-z]{2,8})(/\S*)?$""", RegexOption.IGNORE_CASE)
        private val PAGE_TAIL = Regex("""/(\d+)/?$""")
        private val CREATED_FRAG = Regex("""#c=(\d+)""")
        private val TITLE_YEAR = Regex("""\(\d{4}\)$""")
        private val PRELOAD_REGEX = Regex("""<link[^>]+rel="preload"[^>]+href="(https:[^"]+\.m3u8[^"]*)"""")
        private val VIDEO_SRC_REGEX = Regex("""<video[^>]+src="(https:[^"]+\.mp4[^"]*)"""")
        private val YMD_FMT = SimpleDateFormat("yyyy.MM.dd", Locale.KOREA).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }

        private val ORIENTS = listOf("일반" to "", "게이" to "/gay", "쉬메일" to "/shemale")
        private val FORMATS = listOf("전체" to "", "HD" to "/hd", "4K" to "/4k")
        private val SORTS = listOf(
            "추천 (기본)" to "",
            "최신" to "/newest",
            "인기 전체" to "/best",
            "인기 이번 주" to "/best/weekly",
            "인기 이번 달" to "/best/monthly",
            "조회 전체" to "/most-viewed",
            "조회 이번 주" to "/most-viewed/weekly",
            "조회 이번 달" to "/most-viewed/monthly",
        )

        // 검색 정렬 (사이트 검색은 관련순·최신·조회수만)
        private val SEARCH_SORTS = mapOf(
            "/newest" to "newest",
            "/most-viewed" to "views",
            "/most-viewed/weekly" to "views",
            "/most-viewed/monthly" to "views",
        )

        // 카테고리 (사이트 /categories 화면의 분류 묶음 그대로, 2026-10-28)
        private val CAT_GROUPS: List<Pair<String, List<Pair<String, String>>>> = listOf(
            "제작" to listOf(
                "3D" to "3d",
                "Amateur" to "amateur",
                "Behind the Scenes" to "behind-the-scenes",
                "Caption" to "caption",
                "Cartoon" to "cartoon",
                "Close-up" to "close-up",
                "Compilation" to "compilation",
                "Erotica" to "erotica",
                "Funny" to "funny",
                "Gonzo" to "gonzo",
                "Hentai" to "hentai",
                "Homemade" to "homemade",
                "Interactive" to "interactive",
                "JAV" to "jav",
                "PMV" to "pmv",
                "POV" to "pov",
                "Pornstar" to "pornstar",
                "Retro" to "retro",
                "Show" to "show",
                "Softcore" to "softcore",
                "Story" to "story",
                "Uncensored" to "uncensored",
                "Vintage" to "vintage",
                "Webcam" to "webcam",
            ),
            "행위" to listOf(
                "69" to "69",
                "Anal" to "anal",
                "Anal Masturbation" to "anal-masturbation",
                "Ass Licking" to "ass-licking",
                "Ass to Mouth" to "ass-to-mouth",
                "Blowbang" to "blowbang",
                "Blowjob" to "blowjob",
                "Brutal Sex" to "brutal-sex",
                "Bukkake" to "bukkake",
                "Cowgirl" to "cowgirl",
                "Creampie" to "creampie",
                "Cum Swallowing" to "cum-swallowing",
                "Cum in Mouth" to "cum-in-mouth",
                "Cum on Feet" to "cum-on-feet",
                "Cum on Tits" to "cum-on-tits",
                "Cumshot" to "cumshot",
                "Cumswap" to "cumswap",
                "Cunnilingus" to "cunnilingus",
                "Deep Throat" to "deep-throat",
                "Dirty Talk" to "dirty-talk",
                "Doggy Style" to "doggy-style",
                "Double Penetration" to "double-penetration",
                "Dry Humping" to "dry-humping",
                "Eating Pussy" to "eating-pussy",
                "Edging" to "edging",
                "Extreme Insertion" to "extreme-insertion",
                "Face Fuck" to "face-fuck",
                "Facesitting" to "facesitting",
                "Facial" to "facial",
                "Female Masturbation" to "female-masturbation",
                "Fingering" to "fingering",
                "Fisting" to "fisting",
                "Flashing" to "flashing",
                "Footjob" to "footjob",
                "Foreplay" to "foreplay",
                "Gaping" to "gaping",
                "Handjob" to "handjob",
                "Happy Ending" to "happy-ending",
                "Humping" to "humping",
                "Kissing" to "kissing",
                "Massage" to "massage",
                "Missionary" to "missionary",
                "Moaning" to "moaning",
                "Orgasm" to "orgasm",
                "Pegging" to "pegging",
                "Prostate Massage" to "prostate-massage",
                "Riding" to "riding",
                "Rimjob" to "rimjob",
                "Rough Anal" to "rough-anal",
                "Rough Sex" to "rough-sex",
                "Scissoring" to "scissoring",
                "Screaming" to "screaming",
                "Shaving" to "shaving",
                "Squirting" to "squirting",
                "Striptease" to "striptease",
                "Titty Fucking" to "titty-fucking",
                "Twerking" to "twerking",
                "Yoga" to "yoga",
            ),
            "페티시" to listOf(
                "Ahegao" to "ahegao",
                "Armpit" to "armpit",
                "BDSM" to "bdsm",
                "Ballbusting" to "ballbusting",
                "Balloon" to "balloon",
                "Belly Fetish" to "belly-fetish",
                "Body Hair Fetish" to "body-hair-fetish",
                "Body Paint" to "body-paint",
                "Bondage" to "bondage",
                "CBT" to "cbt",
                "CEI" to "cei",
                "Chastity" to "chastity",
                "Condom" to "condom",
                "Dogging" to "dogging",
                "Domination" to "domination",
                "Estim" to "estim",
                "Face Fetish" to "face-fetish",
                "Farting" to "farting",
                "Femdom" to "femdom",
                "Fetish" to "fetish",
                "Food" to "food",
                "Foot Fetish" to "foot-fetish",
                "Foot Worship" to "foot-worship",
                "Futanari" to "futanari",
                "Gokkun" to "gokkun",
                "Gyno Fetish" to "gyno-fetish",
                "Hand Fetish" to "hand-fetish",
                "Hogtied" to "hogtied",
                "Human Ashtray" to "human-ashtray",
                "Human Furniture" to "human-furniture",
                "Humiliation" to "humiliation",
                "Kinky" to "kinky",
                "Lactating" to "lactating",
                "Lezdom" to "lezdom",
                "Milk" to "milk",
                "Mind Control" to "mind-control",
                "Mouth Fetish" to "mouth-fetish",
                "Oiled" to "oiled",
                "Orgasm Control" to "orgasm-control",
                "Pedal Pumping" to "pedal-pumping",
                "Pet Play" to "pet-play",
                "Pissing" to "pissing",
                "Predicament Bondage" to "predicament-bondage",
                "Punishment" to "punishment",
                "Raceplay" to "raceplay",
                "Shibari" to "shibari",
                "Sissy" to "sissy",
                "Small Penis Encouragement" to "small-penis-encouragement",
                "Small Penis Humiliation" to "small-penis-humiliation",
                "Smoking" to "smoking",
                "Smothering" to "smothering",
                "Spanking" to "spanking",
                "Spitting" to "spitting",
                "Submissive" to "submissive",
                "Suspension Bondage" to "suspension-bondage",
                "Tape Bondage" to "tape-bondage",
                "Tickling" to "tickling",
                "Tied Up" to "tied-up",
                "Trampling" to "trampling",
                "Wax Play" to "wax-play",
                "Wedgie" to "wedgie",
                "Weird" to "weird",
                "Wet and Messy" to "wet-messy",
                "Whipping" to "whipping",
                "Wrestling" to "wrestling",
            ),
            "성향" to listOf(
                "Bisexual" to "bisexual",
                "Lesbian" to "lesbian",
            ),
            "나이" to listOf(
                "18 Year Old" to "18-year-old",
                "Babe" to "babe",
                "Cougar" to "cougar",
                "GILF" to "gilf",
                "Granny" to "granny",
                "MILF" to "milf",
                "Mature" to "mature",
                "Old & Young" to "old-young",
                "Old man" to "old-man",
                "Teen" to "teen",
            ),
            "인종" to listOf(
                "AMWF" to "amwf",
                "African" to "african",
                "American" to "american",
                "Arab" to "arab",
                "Asian" to "asian",
                "Black" to "black",
                "Desi" to "desi",
                "European" to "european",
                "Interracial" to "interracial",
                "Jewish" to "jewish",
                "Latina" to "latina",
                "Mzansi" to "mzansi",
            ),
            "몸" to listOf(
                "Amputee" to "amputee",
                "Ass" to "ass",
                "BBC" to "bbc",
                "BBW" to "bbw",
                "BWC" to "bwc",
                "Beauty" to "beauty",
                "Big Ass" to "big-ass",
                "Big Clit" to "big-clit",
                "Big Cock" to "big-cock",
                "Big Natural Tits" to "big-natural-tits",
                "Big Nipples" to "big-nipples",
                "Big Tits" to "big-tits",
                "Cameltoe" to "cameltoe",
                "Chubby" to "chubby",
                "Clit" to "clit",
                "Cute" to "cute",
                "Exotic" to "exotic",
                "FBB" to "fbb",
                "Fake Tits" to "fake-tits",
                "Flexible" to "flexible",
                "Giant" to "giant",
                "Giantess" to "giantess",
                "Hairy" to "hairy",
                "Hermaphrodite" to "hermaphrodite",
                "Legs" to "legs",
                "Midget" to "midget",
                "Monster Cock" to "monster-cock",
                "Muscular Woman" to "muscular-woman",
                "Nipples" to "nipples",
                "Nude" to "nude",
                "PAWG" to "pawg",
                "Perfect Body" to "perfect-body",
                "Petite" to "petite",
                "Piercing" to "piercing",
                "Pregnant" to "pregnant",
                "Puffy Nipples" to "puffy-nipples",
                "Pussy" to "pussy",
                "SSBBW" to "ssbbw",
                "Saggy Tits" to "saggy-tits",
                "Skinny" to "skinny",
                "Small Tits" to "small-tits",
                "Tan Girl" to "tan-girl",
                "Tattoo" to "tattoo",
                "Tight Pussy" to "tight-pussy",
                "Tits" to "tits",
            ),
            "머리" to listOf(
                "Blonde" to "blonde",
                "Brunette" to "brunette",
                "Colored Hair" to "colored-hair",
                "Long Hair" to "long-hair",
                "Redhead" to "redhead",
                "Short Hair" to "short-hair",
            ),
            "인원" to listOf(
                "Couple" to "couple",
                "Foursome" to "foursome",
                "Gangbang" to "gangbang",
                "Group Sex" to "group-sex",
                "Orgy" to "orgy",
                "Solo" to "solo",
                "Threesome" to "threesome",
            ),
            "도구" to listOf(
                "Anal Beads" to "anal-beads",
                "Ball Gagged" to "ball-gagged",
                "Blindfolded" to "blindfolded",
                "Butt Plug" to "butt-plug",
                "Dildo" to "dildo",
                "Double Dildo" to "double-dildo",
                "Enema" to "enema",
                "Fucking Machine" to "fucking-machine",
                "Hitachi" to "hitachi",
                "Pussy Pump" to "pussy-pump",
                "Sex Toy" to "sex-toy",
                "Strapon" to "strapon",
                "Sybian" to "sybian",
                "Vibrator" to "vibrator",
            ),
            "옷" to listOf(
                "Bikini" to "bikini",
                "Bodystocking" to "bodystocking",
                "Bra" to "bra",
                "Fishnet" to "fishnet",
                "Glasses" to "glasses",
                "Gloves" to "gloves",
                "High Heels" to "high-heels",
                "Jeans" to "jeans",
                "Latex" to "latex",
                "Leather" to "leather",
                "Leggings" to "leggings",
                "Lingerie" to "lingerie",
                "Masked" to "masked",
                "Nylon" to "nylon",
                "Panties" to "panties",
                "Pantyhose" to "pantyhose",
                "School Uniform" to "school-uniform",
                "Skirt" to "skirt",
                "Socks" to "socks",
                "Spandex" to "spandex",
                "Stockings" to "stockings",
                "Thong" to "thong",
                "Uniform" to "uniform",
            ),
            "상황" to listOf(
                "ASMR" to "asmr",
                "Agent" to "agent",
                "Alien" to "alien",
                "Audition" to "audition",
                "Babysitter" to "babysitter",
                "Baddie" to "baddie",
                "Birthday" to "birthday",
                "Body Swap" to "body-swap",
                "Boss" to "boss",
                "Bunny" to "bunny",
                "CFNM" to "cfnm",
                "CMNF" to "cmnf",
                "Casting" to "casting",
                "Catfight" to "catfight",
                "Celebrity" to "celebrity",
                "Cheating" to "cheating",
                "Cheerleader" to "cheerleader",
                "Clown" to "clown",
                "Coed" to "coed",
                "Comic" to "comic",
                "Cook" to "cook",
                "Cosplay" to "cosplay",
                "Cuckold" to "cuckold",
                "Daddy" to "daddy",
                "Dance" to "dance",
                "Doctor" to "doctor",
                "Doll" to "doll",
                "E-girl" to "e-girl",
                "Emo" to "emo",
                "Escort" to "escort",
                "Fantasy" to "fantasy",
                "Fighting" to "fighting",
                "First Time" to "first-time",
                "Game" to "game",
                "Gamer Girl" to "gamer-girl",
                "Ghetto" to "ghetto",
                "Girlfriend" to "girlfriend",
                "Glory Hole" to "glory-hole",
                "Gothic" to "gothic",
                "Halloween" to "halloween",
                "Hardcore" to "hardcore",
                "Horror" to "horror",
                "Housewife" to "housewife",
                "Interview" to "interview",
                "JOI" to "joi",
                "Maid" to "maid",
                "Medical" to "medical",
                "Medieval" to "medieval",
                "Military" to "military",
                "Mistress" to "mistress",
                "Mom" to "mom",
                "Monster" to "monster",
                "Morning" to "morning",
                "Naughty" to "naughty",
                "Neighbor" to "neighbor",
                "Nerd" to "nerd",
                "Nudist" to "nudist",
                "Nun" to "nun",
                "Nurse" to "nurse",
                "Nympho" to "nympho",
                "Parody" to "parody",
                "Party" to "party",
                "Passionate" to "passionate",
                "Pick Up" to "pick-up",
                "Plumber" to "plumber",
                "Police" to "police",
                "Princess" to "princess",
                "Public Nudity" to "public-nudity",
                "Public Sex" to "public-sex",
                "Reverse Gangbang" to "reverse-gangbang",
                "Role Play" to "role-play",
                "Romantic" to "romantic",
                "Secretary" to "secretary",
                "Seduce" to "seduce",
                "Sex Instruction" to "sex-instruction",
                "Slave" to "slave",
                "Sport" to "sport",
                "Stranger" to "stranger",
                "Stuck" to "stuck",
                "Student" to "student",
                "Superhero" to "superhero",
                "Surprise" to "surprise",
                "Swingers" to "swingers",
                "Taboo" to "taboo",
                "Teacher" to "teacher",
                "Time Stop" to "time-stop",
                "Truth or Dare" to "truth-or-dare",
                "Twins" to "twins",
                "Upskirt" to "upskirt",
                "Valentine's Day" to "valentines-day",
                "Vampire" to "vampire",
                "Virgin" to "virgin",
                "Voyeur" to "voyeur",
                "Waitress" to "waitress",
                "Wedding" to "wedding",
                "Wife" to "wife",
                "Wife Sharing" to "wife-sharing",
                "Wife Swap" to "wife-swap",
                "Xmas" to "xmas",
            ),
            "장소" to listOf(
                "Bathroom" to "bathroom",
                "Beach" to "beach",
                "Bus" to "bus",
                "Car" to "car",
                "College" to "college",
                "Farm" to "farm",
                "Fitness" to "fitness",
                "Gym" to "gym",
                "Hospital" to "hospital",
                "Hotel" to "hotel",
                "Jungle" to "jungle",
                "Kitchen" to "kitchen",
                "Office" to "office",
                "Outdoor" to "outdoor",
                "Pool" to "pool",
                "Prison" to "prison",
                "Sauna" to "sauna",
                "Shower" to "shower",
                "Taxi" to "taxi",
                "Toilet" to "toilet",
                "Train" to "train",
                "Underwater" to "underwater",
                "Village" to "village",
            ),
        )

        private val FILTER_DEFS: List<Pair<String, List<Pair<String, String>>>> =
            listOf("방향" to ORIENTS, "화질" to FORMATS, "정렬" to SORTS) +
                CAT_GROUPS.map { (g, items) -> "카테고리 · $g" to (listOf("전체" to "") + items) }
    }
}
