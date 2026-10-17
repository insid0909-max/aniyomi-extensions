package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.annotation.SuppressLint
import android.app.Application
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
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
import eu.kanade.tachiyomi.animesource.model.Track
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 애니라이프 (anilife01.tv). 사이트가 목록·작품·회차·재생 주소를 JSON 으로 준다.
 * 목록: /api/anime?page=&limit=24&scope=&status=&day=&genre=&year=&format=&sort=&q=&v=catalog-media-2
 * 작품(회차 포함): /api/anime/{id}?v=playback-url-v1, 재생: /api/playback/{id}/{회차} → {videoUrl, backupUrl, subtitleUrl}
 * 사이트 화면의 작품 주소는 /content/{id}
 */
class Anilife : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "애니라이프"
    override val lang = "ko"
    override val supportsLatest = true

    // ================= 주소와 설정 =================
    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    override val baseUrl: String
        get() {
            val custom = prefs()?.getString(PREF_DOMAIN_KEY, "")?.trim()?.trimEnd('/').orEmpty()
            return if (DOMAIN_REGEX.matches(custom)) DomainGuard.preferDefault(custom, DEFAULT_BASE_URL) else DEFAULT_BASE_URL
        }

    override val client: OkHttpClient = network.client.newBuilder()
        .addInterceptor(PageCache(Regex("^/api/anime/\\d+$")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS, skipImages = true))
        .addInterceptor { chain ->
            // 사이트가 새 주소로 넘겨 주면 그 주소를 저장 (다음부터 바로 새 주소로)
            val res = chain.proceed(chain.request())
            val from = chain.request().url.host
            val to = res.request.url.host
            if (from != to && HOST_REGEX.matches(from) && HOST_REGEX.matches(to)) {
                prefs()?.edit()?.putString(PREF_DOMAIN_KEY, "https://$to")?.apply()
            }
            res
        }
        .addInterceptor { chain -> domainIntercept(chain) }
        .addInterceptor(RetryOnce(HOST_REGEX))
        .build()

    // ================= 도메인 자동 찾기 =================
    // 주소가 anilife01.tv → anilife02.tv 처럼 번호가 바뀜. 접속이 안 되거나 막히면 앞뒤 번호 주소를 열어 보고,
    // 진짜 애니라이프인 주소를 저장해 다시 요청한다.
    private fun autoDomain(): Boolean = prefs()?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val baseHost = baseUrl.toHttpUrlOrNull()?.host
        if (baseHost == null || req.url.host != baseHost || !autoDomain()) return chain.proceed(req)
        if (NoticeFollow.IMAGE_PATH.containsMatchIn(req.url.encodedPath)) return chain.proceed(req)
        // 재생 주소 API 는 앱에서 부르면 원래 403 (사이트 화면 안에서만 허용) → 주소가 바뀐 신호가 아님.
        // 여기서 주소 찾기를 돌리면 재생 시작이 최대 8초 늦어짐
        if (req.url.encodedPath.startsWith("/api/playback/")) return chain.proceed(req)

        fun retryOn(found: String): Response {
            prefs()?.edit()?.putString(PREF_DOMAIN_KEY, "https://$found")?.apply()
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(found).build()).build())
        }

        val res = try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            val found = discoverDomain(baseHost) ?: throw e
            return retryOn(found)
        }
        val dead = !HOST_REGEX.matches(res.request.url.host) || res.code == 403 || res.code == 451 || res.code >= 500
        if (req.method == "GET" && dead) {
            val found = discoverDomain(baseHost) ?: return res
            res.close()
            return retryOn(found)
        }
        return res
    }

    @Volatile private var lastDiscover = 0L

    private fun discoverDomain(currentHost: String): String? = synchronized(DISCOVER_LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now
        val m = NUM_REGEX.find(currentHost) ?: return null
        val n = m.groupValues[1].toIntOrNull() ?: return null
        val width = m.groupValues[1].length
        fun host(v: Int) = "anilife${v.toString().padStart(width, '0')}.tv"
        // 다음 번호 우선, 그다음 이전 번호
        val plain = OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
        // 공개 주소 목록(중앙신호등: 여러 사이트의 최신 주소를 확인해 올려 두는 곳)에 적힌 주소를 먼저 후보로
        val signal = runCatching {
            plain.newCall(Request.Builder().url("$SIGNAL_URL?t=$now").header("Cache-Control", "no-cache").build()).execute().use { r ->
                JSONObject(r.body.string()).optJSONObject("domains")?.optJSONObject("anilife")?.optString("baseUrl")
                    ?.trimEnd('/')?.toHttpUrlOrNull()?.host?.takeIf { HOST_REGEX.matches(it) }
            }
        }.getOrNull()
        val candidates = (listOfNotNull(signal) + (1..8).map { host(n + it) } + (1..2).mapNotNull { (n - it).takeIf { v -> v > 0 }?.let(::host) })
            .distinct().filter { it != currentHost }
        val pool = java.util.concurrent.Executors.newFixedThreadPool(8)
        try {
            val futures = candidates.map { h ->
                pool.submit<String?> {
                    runCatching {
                        val r = Request.Builder().url("https://$h/").header("User-Agent", USER_AGENT).build()
                        plain.newCall(r).execute().use { res ->
                            val fh = res.request.url.host
                            val ok = HOST_REGEX.matches(fh) && res.code == 200 &&
                                res.peekBody(300_000).string().contains(SITE_MARKER)
                            if (ok) fh else null
                        }
                    }.getOrNull()
                }
            }
            futures.firstNotNullOfOrNull { runCatching { it.get() }.getOrNull() }?.takeIf { it != currentHost }
        } finally {
            pool.shutdown()
        }
    }

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", USER_AGENT)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    private fun apiHeaders(): Headers = headersBuilder().set("Accept", "application/json").build()

    // ================= 목록 =================
    private fun listUrl(idx: IntArray, page: Int, query: String = ""): String {
        val b = "$baseUrl/api/anime".toHttpUrl().newBuilder()
            .addQueryParameter("page", page.toString())
            .addQueryParameter("limit", "24")
        if (query.isNotEmpty()) b.addQueryParameter("q", query)
        SCOPES[idx[0]].second.takeIf { it.isNotEmpty() }?.let { b.addQueryParameter("scope", it) }
        if (idx[1] > 0) b.addQueryParameter("status", STATUSES[idx[1]])
        if (idx[2] > 0) b.addQueryParameter("day", DAYS[idx[2]])
        if (idx[3] > 0) b.addQueryParameter("genre", GENRES[idx[3]])
        if (idx[4] > 0) b.addQueryParameter("year", YEARS[idx[4]])
        if (idx[5] > 0) b.addQueryParameter("format", FORMATS[idx[5]].second)
        b.addQueryParameter("sort", SORTS[idx[6]].second)
        b.addQueryParameter("v", "catalog-media-2")
        return b.build().toString()
    }

    private fun ruleSizes() = intArrayOf(SCOPES.size, STATUSES.size, DAYS.size, GENRES.size, YEARS.size, FORMATS.size, SORTS.size)

    // 기본: 인기 = 사이트 인기 작품, 최신 = 최근 업데이트 (필터의 "인기/최신 탭 규칙"으로 바꿀 수 있음)
    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), apiHeaders())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), apiHeaders())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        // 작품 주소(…/content/123)를 붙여 넣으면 그 작품을 바로 열기
        ID_REGEX.find(query.trim())?.let { m -> return GET(detailUrl(m.groupValues[1]), apiHeaders()) }
        fun sel(f: AnimeFilter.Select<*>?, def: Int) = f?.state ?: def
        val idx = intArrayOf(
            sel(filters.filterIsInstance<ScopeFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<StatusFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<DayFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<GenreFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<YearFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<FormatFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<SortFilter>().firstOrNull(), DEFAULT_SORT),
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page, query.trim()), apiHeaders())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        if (DETAIL_PATH.matches(response.request.url.encodedPath)) {
            val item = itemOf(response) ?: return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(card(item)), false)
        }
        return parseList(response)
    }

    private fun json(response: Response): JSONObject {
        val body = response.body.string()
        if (!response.isSuccessful) {
            val msg = runCatching { JSONObject(body).optString("error") }.getOrNull().orEmpty()
            throw Exception("애니라이프 접속 실패 (HTTP ${response.code}) ${msg.take(60)}".trim())
        }
        return runCatching { JSONObject(body) }.getOrElse {
            throw Exception("애니라이프 응답을 읽지 못했습니다. 주소가 바뀌었으면 설정에서 새 주소를 넣어 주세요.")
        }
    }

    private fun parseList(response: Response): AnimesPage {
        val o = json(response)
        val items = o.optJSONArray("items")
        val animes = (0 until (items?.length() ?: 0)).mapNotNull { items!!.optJSONObject(it)?.let(::card) }
        val pg = o.optJSONObject("pagination")
        val hasNext = pg != null && pg.optInt("page", 1) < pg.optInt("pages", 1)
        return AnimesPage(animes, hasNext)
    }

    /** 목록 카드: 완결·극장판은 제목 뒤에 (연도) */
    private fun card(o: JSONObject): SAnime = SAnime.create().apply {
        url = "/content/${str(o, "id")}"
        title = titleOf(o)
        thumbnail_url = abs(str(o, "image").ifEmpty { str(o, "bannerImage") }).ifEmpty { null }
        status = statusOf(o)
    }

    private fun titleOf(o: JSONObject): String {
        val t = str(o, "title").ifEmpty { str(o, "titleOriginal") }
        val year = o.optInt("year", 0)
        val ended = str(o, "status") == "완결" || str(o, "format") == "Movie"
        return if (ended && year > 0 && !t.contains("($year)")) "$t ($year)" else t
    }

    private fun statusOf(o: JSONObject): Int = when {
        str(o, "status") == "방영중" -> SAnime.ONGOING
        str(o, "status") == "완결" || str(o, "format") == "Movie" -> SAnime.COMPLETED
        else -> SAnime.UNKNOWN
    }

    // ================= 작품 정보 =================
    private fun idOf(url: String): String = ID_REGEX.find(url)?.groupValues?.get(1) ?: url.filter { it.isDigit() }

    private fun detailUrl(id: String) = "$baseUrl/api/anime/$id?v=playback-url-v1"

    override fun animeDetailsRequest(anime: SAnime): Request = GET(detailUrl(idOf(anime.url)), apiHeaders())

    override fun getAnimeUrl(anime: SAnime): String = "$baseUrl/content/${idOf(anime.url)}"

    private fun itemOf(response: Response): JSONObject? = json(response).optJSONObject("item")

    override fun animeDetailsParse(response: Response): SAnime {
        val o = itemOf(response) ?: throw Exception("작품 정보를 찾지 못했습니다")
        val latest = episodesOf(o).mapNotNull { it.date }.maxOrNull() ?: dateOf(str(o, "lastUpdatedAt"))
        val ongoing = str(o, "status") == "방영중"
        val tags = listOf("genres", "tags").flatMap { k ->
            val a = o.optJSONArray(k)
            (0 until (a?.length() ?: 0)).mapNotNull { a!!.optString(it).trim().ifEmpty { null } }
        }.distinct()
        return card(o).apply {
            genre = tags.joinToString(", ").ifEmpty { null }
            author = str(o, "studio").ifEmpty { null }
            artist = str(o, "director").ifEmpty { null }
            if (str(o, "format") == "Movie") update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            val air = listOfNotNull(
                DAY_NAMES[str(o, "day")]?.let { d -> "매주 $d" + str(o, "broadcastTime").let { if (it.isNotEmpty()) " $it" else "" } },
                str(o, "season").ifEmpty { null },
            ).joinToString(" · ")
            val info = listOfNotNull(
                listOfNotNull(
                    FORMAT_NAMES[str(o, "format")] ?: str(o, "format").ifEmpty { null },
                    o.optInt("year", 0).takeIf { it > 0 }?.let { "${it}년" },
                    o.optInt("episodeCount", 0).takeIf { it > 0 }?.let { "${it}화" },
                    str(o, "status").ifEmpty { null },
                ).joinToString(" · ").ifEmpty { null },
                air.ifEmpty { null },
                str(o, "studio").ifEmpty { null }?.let { "제작: $it" },
                str(o, "director").ifEmpty { null }?.let { "감독: $it" },
                str(o, "originalWork").ifEmpty { str(o, "original") }.ifEmpty { null }?.let { "원작: $it" },
                str(o, "titleJp").ifEmpty { null }?.let { "원제: $it" },
            ).joinToString("\n")
            description = listOfNotNull(
                if (ongoing && latest != null) "방영 중 · 최근 방영: ${synchronized(OUT_FMT) { OUT_FMT.format(latest) }}" else null,
                str(o, "description").replace("\r", "").trim().ifEmpty { null },
                info.ifEmpty { null },
            ).joinToString("\n\n")
        }
    }

    // ================= 회차 =================
    private class Ep(val key: String, val number: Double, val title: String, val date: java.util.Date?, val playback: String)

    private fun episodesOf(o: JSONObject): List<Ep> {
        val arr = o.optJSONArray("episodes") ?: return emptyList()
        val id = str(o, "id")
        return (0 until arr.length()).mapNotNull { i ->
            val e = arr.optJSONObject(i) ?: return@mapNotNull null
            val key = str(e, "key").ifEmpty { str(e, "number") }.ifEmpty { (i + 1).toString() }
            val hasUrl = listOf("playbackUrl", "videoUrl", "backupUrl").any { str(e, it).isNotEmpty() }
            if (!e.optBoolean("playable", true) && !hasUrl) return@mapNotNull null
            val number = e.optDouble("number", Double.NaN).takeUnless { it.isNaN() }
                ?: EP_NUM_REGEX.find(str(e, "title"))?.groupValues?.get(1)?.toDoubleOrNull()
                ?: (i + 1).toDouble()
            val playback = str(e, "playbackUrl").let { p -> p.toHttpUrlOrNull()?.encodedPath ?: p.substringBefore('?') }
                .ifEmpty { "/api/playback/$id/$key" }
            Ep(key, number, str(e, "title"), dateOf(str(e, "date")), playback)
        }
    }

    override fun episodeListRequest(anime: SAnime): Request = animeDetailsRequest(anime)

    override fun episodeListParse(response: Response): List<SEpisode> {
        val o = itemOf(response) ?: return emptyList()
        val eps = episodesOf(o)
        val movie = str(o, "format") == "Movie" && eps.size == 1
        val used = HashSet<Float>()
        return eps.map { ep ->
            val numText = if (ep.number == Math.floor(ep.number)) ep.number.toLong().toString() else ep.number.toString()
            val base = when {
                movie -> "본편"
                ep.number > 0 -> "${numText}화"
                else -> ep.title.ifEmpty { "특별편" }
            }
            var n = ep.number.toFloat()
            while (!used.add(n)) n += 0.01f
            SEpisode.create().apply {
                url = ep.playback
                name = base + (ep.date?.let { d -> " (${synchronized(SHORT_FMT) { SHORT_FMT.format(d) }})" } ?: "")
                episode_number = n
                date_upload = ep.date?.time ?: 0L
            }
        }.sortedByDescending { it.episode_number }
    }

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val m = PLAYBACK_REGEX.find(episode.url) ?: throw Exception("잘못된 회차 주소입니다. 회차 목록을 새로고침해 주세요")
        val (animeId, key) = m.destructured
        var main = ""
        var backup = ""
        var sub = ""
        var apiError = ""
        // 사이트 재생 화면(/content/작품/회차)에서 부르는 것처럼 그 화면 주소를 Referer 로
        val page = "$baseUrl/content/$animeId/$key"

        // 앱에서 바로 부르는 재생 API·작품 정보 (휴대폰에서는 대개 403 이라 웹뷰로 넘어감)
        fun direct() {
            try {
                val url = "$baseUrl${episode.url.substringBefore('?')}?request=${System.currentTimeMillis()}-0"
                val hh = apiHeaders().newBuilder().set("Referer", page).set("Cache-Control", "no-store").build()
                client.newCall(GET(url, hh)).execute().use { res ->
                    val o = json(res)
                    main = str(o, "videoUrl")
                    backup = str(o, "backupUrl")
                    sub = str(o, "subtitleUrl")
                    if (main.isEmpty() && backup.isEmpty()) apiError = "빈 응답 ${o.toString().take(80)}"
                }
            } catch (e: Exception) {
                apiError = e.message.orEmpty()
            }
            // 재생 주소를 못 받으면 작품 정보에 적힌 주소를 씀
            if (main.isEmpty() && backup.isEmpty()) {
                runCatching {
                    client.newCall(GET(detailUrl(animeId), apiHeaders())).execute().use { res ->
                        val arr = itemOf(res)?.optJSONArray("episodes")
                        val e = (0 until (arr?.length() ?: 0)).mapNotNull { arr!!.optJSONObject(it) }
                            .firstOrNull { str(it, "key") == key || str(it, "number") == key }
                        if (e != null) {
                            main = str(e, "videoUrl")
                            backup = str(e, "backupUrl")
                            if (sub.isEmpty()) sub = str(e, "subtitleUrl")
                        }
                    }
                }
            }
        }
        // 바로 부르기가 최근에 실패했으면 건너뛰고 웹뷰부터 (6시간 기억)
        val skipDirect = (prefs()?.getLong(PREF_DIRECT_FAIL_UNTIL, 0L) ?: 0L) > System.currentTimeMillis()
        if (!skipDirect) direct()
        var vh = videoHeaders()
        // 그래도 없으면 숨은 화면(WebView)으로 사이트 재생 화면을 열어 영상 주소를 받음
        if (main.isEmpty() && backup.isEmpty()) {
            val found = sniffWithWebView(page, "$baseUrl/")
            if (found != null) {
                main = found.url
                if (backup.isEmpty()) backup = found.backup
                if (sub.isEmpty()) sub = found.sub
                vh = videoHeaders(found.referer)
                if (!skipDirect) prefs()?.edit()?.putLong(PREF_DIRECT_FAIL_UNTIL, System.currentTimeMillis() + DIRECT_SKIP_MS)?.apply()
            } else if (skipDirect) {
                // 웹뷰가 안 되면 건너뛴 바로 부르기를 다시 해 봄
                prefs()?.edit()?.remove(PREF_DIRECT_FAIL_UNTIL)?.apply()
                direct()
            }
            if (main.isEmpty() && backup.isEmpty()) {
                throw Exception("재생 주소를 받지 못했습니다. 잠시 뒤 다시 시도해 주세요 [$apiError]".replace(" []", ""))
            }
        }
        val subs = if (sub.isNotEmpty()) listOf(Track(abs(sub), "한국어")) else emptyList()
        // 기본 주소가 안 열리면 대체 주소를 먼저
        val servers = listOf(abs(main) to LABEL, abs(backup) to "$LABEL (대체 1)").filter { it.first.isNotEmpty() }.distinctBy { it.first }
        // 서버별 화질 목록을 동시에 받고, 기본 주소의 화질 목록을 받았으면 열리는지 따로 확인하지 않음
        val lists = servers.map { (u, label) -> async { HlsQuality.expand(client, u, label, vh) } }.awaitAll()
        val mainOk = lists.size < 2 || lists[0].size > 1 || HlsQuality.works(client, servers[0].first, vh)
        val expanded = (if (mainOk) lists else lists.reversed()).flatten()
        val videos = expanded.map { Video(it.url, it.quality, it.videoUrl, vh, subs) }
        HlsQuality.sort(prefs(), videos)
    }

    private fun videoHeaders(referer: String = "$baseUrl/"): Headers {
        val origin = referer.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" } ?: baseUrl
        return Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", referer)
            .set("Origin", origin)
            .build()
    }

    private class Sniffed(val url: String, val referer: String, val backup: String = "", val sub: String = "", val via: String = "m3u8")

    /**
     * 숨은 WebView 로 재생 화면을 열고 영상 주소를 받음.
     * 화면이 재생 주소 API(/api/playback/…)를 부르면 그 요청을 화면 대신 보내 응답에서 바로 주소를 꺼냄
     * (플레이어가 준비돼 m3u8 을 부를 때까지 기다리지 않아 빠름). 안 되면 처음 나오는 m3u8 요청 주소.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun sniffWithWebView(url: String, referer: String): Sniffed? {
        val latch = CountDownLatch(1)
        var found: Sniffed? = null
        var lastPage = url
        val handler = Handler(Looper.getMainLooper())
        var webViewRef: WebView? = null

        handler.post {
            try {
                val context = Class.forName("android.app.ActivityThread")
                    .getMethod("currentApplication").invoke(null) as Application
                val webView = WebView(context)
                webViewRef = webView
                webView.settings.javaScriptEnabled = true
                webView.settings.domStorageEnabled = true
                // 먼저 자동 재생을 막은 채로 열어 영상 주소만 찾음 (숨은 화면에서 소리가 나 음량 막대가 뜨지 않게).
                // 못 찾으면 아래에서 자동 재생을 켜고 다시 연다
                webView.settings.mediaPlaybackRequiresUserGesture = true
                webView.settings.userAgentString = USER_AGENT
                // 그림은 받지 않아 영상 주소를 더 빨리 찾음
                webView.settings.blockNetworkImage = true
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, pageUrl: String, favicon: android.graphics.Bitmap?) {
                        lastPage = pageUrl
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val path = request.url.path?.lowercase().orEmpty()
                        if (found == null && request.method == "GET" && path.startsWith("/api/playback/")) {
                            apiFromWebView(request, lastPage)?.let { (res, hit) ->
                                if (hit != null && found == null) {
                                    found = hit
                                    latch.countDown()
                                }
                                return res
                            }
                        }
                        if (found == null && (path.endsWith(".m3u8") || path.endsWith(".mp4"))) {
                            found = Sniffed(request.url.toString(), request.requestHeaders["Referer"] ?: lastPage)
                            latch.countDown()
                        }
                        // 광고·통계 요청은 빈 응답으로 막아 로딩을 줄임
                        if (BLOCKED_HOSTS.any { request.url.host?.endsWith(it) == true }) {
                            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }
                webView.loadUrl(url, mapOf("Referer" to referer))
            } catch (e: Exception) {
                latch.countDown()
            }
        }

        if (!latch.await(12, TimeUnit.SECONDS)) {
            // 재생을 눌러야만 영상 주소를 받는 경우: 자동 재생을 켜고 다시 열어 봄
            handler.post {
                runCatching {
                    webViewRef?.settings?.mediaPlaybackRequiresUserGesture = false
                    webViewRef?.loadUrl(url, mapOf("Referer" to referer))
                }
            }
            latch.await(15, TimeUnit.SECONDS)
        }
        handler.post {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }
        return found
    }

    /** 화면의 재생 주소 API 요청을 화면의 쿠키·헤더 그대로 대신 보내고, 응답을 화면에도 돌려줌. 실패하면 null (화면이 직접 보냄) */
    private fun apiFromWebView(request: WebResourceRequest, page: String): Pair<WebResourceResponse, Sniffed?>? = runCatching {
        val u = request.url.toString()
        val b = Request.Builder().url(u)
        request.requestHeaders.forEach { (k, v) -> b.header(k, v) }
        android.webkit.CookieManager.getInstance().getCookie(u)?.let { b.header("Cookie", it) }
        if (request.requestHeaders.keys.none { it.equals("User-Agent", true) }) b.header("User-Agent", USER_AGENT)
        client.newCall(b.build()).execute().use { res ->
            if (!res.isSuccessful) return@runCatching null
            val bytes = res.body.bytes()
            val o = runCatching { JSONObject(String(bytes, Charsets.UTF_8)) }.getOrNull()
            val main = o?.let { str(it, "videoUrl") }.orEmpty()
            val backup = o?.let { str(it, "backupUrl") }.orEmpty()
            val hit = if (main.isNotEmpty() || backup.isNotEmpty()) {
                Sniffed(abs(main.ifEmpty { backup }), page, if (main.isNotEmpty()) abs(backup) else "", o?.let { str(it, "subtitleUrl") }.orEmpty(), "API")
            } else {
                null
            }
            val type = res.header("Content-Type") ?: "application/json"
            WebResourceResponse(type.substringBefore(';').trim(), "UTF-8", res.code, "OK", mapOf("Content-Type" to type), ByteArrayInputStream(bytes)) to hit
        }
    }.getOrNull()

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList {
        fun text(i: IntArray) = listOfNotNull(
            SCOPES[i[0]].first,
            STATUSES[i[1]].takeIf { i[1] > 0 },
            DAYS[i[2]].takeIf { i[2] > 0 }?.let { "${it}요일" },
            GENRES[i[3]].takeIf { i[3] > 0 },
            YEARS[i[4]].takeIf { i[4] > 0 }?.let { "${it}년" },
            FORMATS[i[5]].first.takeIf { i[5] > 0 },
            SORTS[i[6]].first,
        ).joinToString(" · ")
        val host = baseUrl.substringAfter("://")
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("📡 주소: $host · 자동 찾기 ${if (autoDomain()) "켜짐" else "꺼짐"}"),
                AnimeFilter.Separator(),
                AnimeFilter.Header("검색어와 함께 쓸 수 있음 (작품 주소를 붙여 넣으면 바로 열기)"),
                ScopeFilter(),
                StatusFilter(),
                DayFilter(),
                GenreFilter(),
                YearFilter(),
                FormatFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class ScopeFilter : AnimeFilter.Select<String>("목록", SCOPES.map { it.first }.toTypedArray())
    class StatusFilter : AnimeFilter.Select<String>("상태", STATUSES.toTypedArray())
    class DayFilter : AnimeFilter.Select<String>("요일", DAYS.map { if (it == "전체") it else "${it}요일" }.toTypedArray())
    class GenreFilter : AnimeFilter.Select<String>("장르", GENRES.toTypedArray())
    class YearFilter : AnimeFilter.Select<String>("연도", YEARS.toTypedArray())
    class FormatFilter : AnimeFilter.Select<String>("형식", FORMATS.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray(), DEFAULT_SORT)

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "애니라이프 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다. 사이트가 새 주소로 넘겨 주면 자동으로 저장됩니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 애니라이프 주소 (예: https://anilife02.tv)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://anilife02.tv)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        androidx.preference.SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "접속이 안 되거나 막히면 다음 애니라이프 주소(anilife01 → anilife02 …)를 찾아 자동 변경합니다."
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    // ================= 유틸 =================
    /** JSON 의 null 은 빈 글자로 */
    private fun str(o: JSONObject, k: String): String = if (o.isNull(k)) "" else o.optString(k).trim()

    private fun abs(u: String): String = when {
        u.isEmpty() -> ""
        u.startsWith("http") -> u
        u.startsWith("//") -> "https:$u"
        u.startsWith("/") -> baseUrl + u
        else -> "$baseUrl/$u"
    }

    private fun dateOf(s: String): java.util.Date? =
        if (s.length < 10) null else runCatching { synchronized(IN_FMT) { IN_FMT.parse(s.substring(0, 10)) } }.getOrNull()

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val PREF_DIRECT_FAIL_UNTIL = "pref_direct_fail_until"
        private const val DIRECT_SKIP_MS = 6 * 60 * 60 * 1000L
        private val DISCOVER_LOCK = Any()
        private const val DEFAULT_BASE_URL = "https://anilife01.tv"
        private const val RATE_GAP_MS = 250L
        private const val LABEL = "애니라이프"
        private const val SITE_MARKER = "애니라이프"
        private const val SIGNAL_URL = "https://wankyo83.github.io/tokki-traffic-light/domains.json"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?anilife\d+\.tv$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?anilife\d+\.tv$""")
        private val NUM_REGEX = Regex("""anilife(\d+)\.tv""")
        private val ID_REGEX = Regex("""(?:/content/|/api/anime/)(\d+)""")
        private val DETAIL_PATH = Regex("""^/api/anime/\d+$""")
        private val PLAYBACK_REGEX = Regex("""/api/playback/(\d+)/([^/?#]+)""")
        private val EP_NUM_REGEX = Regex("""(\d+(?:\.\d+)?)\s*화""")

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "cloudflareinsights.com",
            "openwebtorrent.com",
            "webtorrent.dev",
        )

        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val IN_FMT = SimpleDateFormat("yyyy-MM-dd", Locale.KOREA).apply { timeZone = KST }
        private val OUT_FMT = SimpleDateFormat("yyyy.MM.dd (E)", Locale.KOREA).apply { timeZone = KST }
        private val SHORT_FMT = SimpleDateFormat("MM.dd", Locale.KOREA).apply { timeZone = KST }

        /** 목록 종류 (사이트 메뉴: 인기 작품 · 최근 업데이트) */
        private val SCOPES = listOf("전체 작품" to "", "인기 작품" to "popular", "최근 업데이트" to "updates")
        private val STATUSES = listOf("전체", "방영중", "완결", "방영예정")
        private val DAYS = listOf("전체", "월", "화", "수", "목", "금", "토", "일")
        private val FORMATS = listOf("전체" to "", "TV" to "TV", "극장판" to "Movie", "OVA" to "OVA", "ONA" to "ONA")
        private val FORMAT_NAMES = mapOf("Movie" to "극장판")
        private val DAY_NAMES = DAYS.drop(1).associateWith { "${it}요일" }

        /** 정렬 (사이트: 인기순·최신순·평점순·이름순) */
        private val SORTS = listOf("인기순" to "popular", "최신순" to "latest", "평점순" to "rating", "이름순" to "title")
        private const val DEFAULT_SORT = 1

        /** 장르 (사이트 장르 중 작품이 5개 이상인 것, 0 = 전체) */
        private val GENRES = listOf(
            "전체", "코미디", "액션", "판타지", "드라마", "로맨스", "일상", "모험", "SF", "초자연", "미스터리", "에치",
            "스포츠", "음악", "메카", "심리", "호러", "마법소녀", "스릴러", "소년", "학원", "서스펜스", "이세계", "미식",
            "중국 애니", "성인 캐스트", "청년", "역사", "초능력", "BL", "환생", "밀리터리", "GL", "우주", "아방가르드",
            "웹툰원작", "신화", "소녀", "무술", "수상작", "탐정", "하렘", "시간여행", "패러디", "레이싱", "직장",
            "어반 판타지", "의인화", "치유",
        )

        /** 연도 (올해부터 1977년까지, 0 = 전체) */
        private val YEARS = listOf("전체") + (Calendar.getInstance(KST).get(Calendar.YEAR).coerceAtLeast(2026) downTo 1977).map { it.toString() }

        // 인기 = 인기 작품 · 인기순, 최신 = 최근 업데이트 · 최신순
        private val DEFAULT_POPULAR = intArrayOf(1, 0, 0, 0, 0, 0, 0)
        private val DEFAULT_LATEST = intArrayOf(2, 0, 0, 0, 0, 0, 1)
    }
}
