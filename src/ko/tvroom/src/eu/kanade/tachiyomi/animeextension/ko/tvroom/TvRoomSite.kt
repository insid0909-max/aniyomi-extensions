package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.annotation.SuppressLint
import android.app.Application
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
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
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.io.ByteArrayInputStream
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 티비룸 (tvroomNN.org).
 * 브라우저 환경과 동일한 User-Agent 및 필수 헤더를 전달하며, 
 * 1회성 토큰 소진을 방지하기 위해 MPV 플레이어로 직접 스트림을 연결합니다.
 */
class TvRoomSite : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "티비룸"
    override val lang = "ko"
    override val supportsLatest = true

    // ================= 기기 브라우저 User-Agent =================
    private val systemUserAgent: String by lazy {
        runCatching {
            val app = Class.forName("android.app.ActivityThread")
                .getMethod("currentApplication").invoke(null) as Application
            WebSettings.getDefaultUserAgent(app)
        }.getOrDefault(DEFAULT_UA)
    }

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
            return if (DOMAIN_REGEX.matches(custom)) custom else DEFAULT_BASE_URL
        }

    override val client: OkHttpClient = network.cloudflareClient.newBuilder()
        .addInterceptor(PageCache(Regex("^/video/[^/]+")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS))
        .addInterceptor { chain ->
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
    private fun autoDomain(): Boolean = prefs()?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

    private fun isCfChallenge(res: Response) = res.header("cf-mitigated") != null

    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val baseHost = baseUrl.toHttpUrlOrNull()?.host
        if (baseHost == null || req.url.host != baseHost || !autoDomain()) return chain.proceed(req)

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
        val dead = !HOST_REGEX.matches(res.request.url.host) ||
            ((res.code == 403 || res.code == 451 || res.code >= 500) && !isCfChallenge(res))
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
        val tld = m.groupValues[2]
        val candidates = (1..8).map { "tvroom${n + it}.$tld" } +
            (1..2).mapNotNull { (n - it).takeIf { v -> v > 0 }?.let { v -> "tvroom$v.$tld" } }
        val plain = OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
        val pool = java.util.concurrent.Executors.newFixedThreadPool(8)
        try {
            val futures = candidates.map { host ->
                pool.submit<String?> {
                    runCatching {
                        val r = Request.Builder().url("https://$host/").header("User-Agent", systemUserAgent).build()
                        plain.newCall(r).execute().use { res ->
                            val fh = res.request.url.host
                            val ok = HOST_REGEX.matches(fh) &&
                                (
                                    (res.code == 200 && res.peekBody(300_000).string().contains(SITE_MARKER)) ||
                                        (isCfChallenge(res) && res.peekBody(20_000).string().contains(fh))
                                    )
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
        .set("User-Agent", systemUserAgent)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 목록 =================
    private fun listUrl(cat: Int, region: Int, sort: Int, page: Int): String {
        val b = "$baseUrl/video".toHttpUrl().newBuilder()
            .addPathSegment(CATEGORIES.getOrElse(cat) { CATEGORIES[DEFAULT_CAT] }.second)
            .addPathSegment(REGIONS.getOrElse(region) { REGIONS[0] })
            .addPathSegment(SORTS.getOrElse(sort) { SORTS[0] })
        if (page > 1) b.addQueryParameter("page", page.toString())
        return b.build().toString()
    }

    private fun ruleSizes() = intArrayOf(CATEGORIES.size, REGIONS.size, SORTS.size)

    private fun savedRule(popular: Boolean, page: Int): Request? =
        TabRule.read(prefs(), popular, ruleSizes())?.let { GET(listUrl(it[0], it[1], it[2], page), h()) }

    override fun popularAnimeRequest(page: Int): Request = savedRule(true, page) ?: GET(listUrl(DEFAULT_CAT, 0, 1, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun latestUpdatesRequest(page: Int): Request = savedRule(false, page) ?: GET(listUrl(DEFAULT_CAT, 0, 0, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        animePathOf(query.trim())?.let { return GET(baseUrl + it, h()) }
        if (query.isNotBlank()) {
            val url = "$baseUrl/search".toHttpUrl().newBuilder()
                .addPathSegment(query.trim())
                .apply { if (page > 1) addQueryParameter("page", page.toString()) }
                .build()
            return GET(url.toString(), h())
        }
        val cat = filters.filterIsInstance<CategoryFilter>().firstOrNull()?.state ?: DEFAULT_CAT
        val region = filters.filterIsInstance<RegionFilter>().firstOrNull()?.state ?: 0
        val sort = filters.filterIsInstance<SortFilter>().firstOrNull()?.state ?: 0
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let {
            TabRule.apply(prefs(), it.state, intArrayOf(cat, region, sort))
        }
        return GET(listUrl(cat, region, sort, page), h())
    }

    private fun animePathOf(text: String): String? {
        val url = text.toHttpUrlOrNull() ?: return null
        if (!HOST_REGEX.matches(url.host)) return null
        val segs = url.encodedPathSegments
        if (segs.size < 2 || segs[0] != "video" || segs[1].isEmpty()) return null
        return "/video/${segs[1]}"
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val url = response.request.url
        if (url.encodedPathSegments.firstOrNull() == "video") {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { this.url = animePathOf(url.toString()) ?: url.encodedPath }), false)
        }
        return parseList(response.asDoc())
    }

    private fun parseList(doc: Document): AnimesPage {
        val seen = HashSet<String>()
        val cards = doc.select(".module-item, .search-result-item")
            .filterNot { it.parents().any { p -> p.hasClass("owl-carousel") } }
        val animes = cards.mapNotNull { item ->
            val a = item.selectFirst("a.v-item-hitarea[href], a.search-result-item-hitarea[href]") ?: return@mapNotNull null
            val path = animePathOf(a.absUrl("href")) ?: return@mapNotNull null
            if (!seen.add(path)) return@mapNotNull null
            SAnime.create().apply {
                url = path
                title = a.attr("aria-label").trim().ifEmpty { null }
                    ?: item.selectFirst(".v-item-title, .title")?.text()?.trim().orEmpty()
                thumbnail_url = item.selectFirst("img")?.let(::imgOf)
                description = item.selectFirst(".desc")?.text()?.trim()
                genre = item.select(".v-item-bottom a, .tags a").joinToString(", ") { it.text().trim() }.ifEmpty { null }
            }
        }.filter { it.title.isNotEmpty() }
        val hasNext = doc.selectFirst("ul.pagination a[rel=next]") != null
        return AnimesPage(animes, hasNext)
    }

    private fun imgOf(img: Element): String? =
        listOf(img.absUrl("data-src"), img.absUrl("src")).firstOrNull { it.isNotEmpty() && !it.contains("/resource/image/") }

    // ================= 작품 정보 =================
    override fun animeDetailsParse(response: Response): SAnime {
        val doc = response.asDoc()
        val eps = doc.select(".episode-list a.episode-item")
        val genres = infoRow(doc, "장르")
        return SAnime.create().apply {
            title = doc.selectFirst(".play-box-side .detail-title strong")?.text()?.trim()?.ifEmpty { null }
                ?: doc.selectFirst(".detail-box-header h1")?.text()?.substringBeforeLast(" - ")?.trim().orEmpty()
            thumbnail_url = doc.selectFirst(".detail-pic img")?.let(::imgOf)
                ?: doc.selectFirst("meta[property=og:image]")?.attr("content")
            description = listOfNotNull(
                doc.selectFirst(".detail-desc")?.text()?.trim(),
                infoRow(doc, "개봉")?.let { "개봉: $it" },
                infoRow(doc, "국가")?.let { "국가: $it" },
            ).joinToString("\n\n").ifEmpty { null }
            genre = genres
            author = infoRow(doc, "감독")
            artist = infoRow(doc, "출연")
            if (eps.size <= 1 && eps.firstOrNull()?.text()?.replace(" ", "")?.contains("본편") != false) {
                status = SAnime.COMPLETED
                update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            } else {
                status = SAnime.UNKNOWN
            }
        }
    }

    private fun infoRow(doc: Document, key: String): String? = doc.select(".detail-info-row")
        .firstOrNull { it.selectFirst(".detail-info-row-side")?.text()?.contains(key) == true }
        ?.selectFirst(".detail-info-row-main")?.text()?.trim()?.ifEmpty { null }

    // ================= 회차 =================
    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val items = doc.select(".episode-list a.episode-item[href]").mapNotNull { a ->
            val url = a.absUrl("href").toHttpUrlOrNull() ?: return@mapNotNull null
            val label = a.text().trim()
            Triple(url.encodedPath, label, EP_NUM_REGEX.find(label)?.groupValues?.get(1)?.toFloatOrNull())
        }.distinctBy { it.first }
        if (items.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    url = response.request.url.encodedPath
                    name = "본편"
                    episode_number = 1f
                },
            )
        }
        val ordered = if (items.all { it.third != null }) items.sortedBy { it.third } else items
        return ordered.mapIndexed { i, (path, label, num) ->
            SEpisode.create().apply {
                url = path
                val d = dateOf(label)
                val base = label.replace(LABEL_DATE_REGEX, "").trim().replace(" ", "").let {
                    when {
                        num != null -> "${num.toString().removeSuffix(".0")}화"
                        it == "본편" -> "본편"
                        else -> label.replace(LABEL_DATE_REGEX, "").trim().ifEmpty { label }
                    }
                }
                name = if (d > 0) "$base (${mmdd(d)})" else base
                episode_number = (i + 1).toFloat()
                date_upload = d
            }
        }.reversed()
    }

    private fun dateOf(text: String): Long {
        val (y, mo, d) = DATE_REGEX.find(text)?.let {
            Triple(it.groupValues[1].toInt(), it.groupValues[2].toInt(), it.groupValues[3].toInt())
        } ?: SHORT_DATE_REGEX.find(text)?.let {
            Triple(2000 + it.groupValues[1].toInt(), it.groupValues[2].toInt(), it.groupValues[3].toInt())
        } ?: return 0L
        if (mo !in 1..12 || d !in 1..31) return 0L
        return runCatching {
            Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul")).apply {
                clear()
                set(y, mo - 1, d)
            }.timeInMillis
        }.getOrDefault(0L)
    }

    private fun mmdd(t: Long): String = java.text.SimpleDateFormat("MM.dd", java.util.Locale.KOREAN)
        .apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(java.util.Date(t))

    // ================= 영상 =================
    override fun videoListRequest(episode: SEpisode): Request = GET(baseUrl + episode.url, h())

    override fun videoListParse(response: Response): List<Video> {
        val pageUrl = response.request.url.toString()
        val doc = Jsoup.parse(response.body.string(), pageUrl)
        val player = doc.selectFirst("iframe#view_iframe, .play-box-main iframe")?.let { f ->
            f.absUrl("src").ifEmpty { f.absUrl("data-src") }
        }?.takeIf { it.startsWith("http") }
            ?: throw Exception("플레이어를 찾지 못했습니다 (영상이 없는 회차일 수 있습니다)")

        val (media, referer, cookie) = sniffWithWebView(player, pageUrl)
            ?: throw Exception("영상 주소를 찾지 못했습니다: $player")

        // 1회성 토큰 소진 방지를 위해 중간 파싱(expand) 없이 원본 헤더와 함께 MPV에 직접 전달
        val headers = videoHeaders(referer, cookie)
        return listOf(
            Video(media, "티비룸 (HLS)", media, headers)
        )
    }

    private fun videoHeaders(referer: String, cookie: String? = null): Headers {
        val refererUrl = referer.toHttpUrlOrNull()
        val origin = refererUrl?.let { "${it.scheme}://${it.host}" }
        return Headers.Builder()
            .set("User-Agent", systemUserAgent)
            .set("Referer", referer)
            .set("Accept", "*/*")
            .apply {
                if (origin != null) set("Origin", origin)
                if (!cookie.isNullOrEmpty()) set("Cookie", cookie)
            }
            .build()
    }

    private fun isMedia(path: String): Boolean = path.endsWith(".m3u8") || path.contains("/m3u8/") || path.endsWith(".mp4")

    @SuppressLint("SetJavaScriptEnabled")
    private fun sniffWithWebView(url: String, referer: String): Triple<String, String, String>? {
        val latch = CountDownLatch(1)
        var found: Triple<String, String, String>? = null
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
                webView.settings.databaseEnabled = true
                webView.settings.mediaPlaybackRequiresUserGesture = true
                webView.settings.userAgentString = systemUserAgent
                webView.settings.blockNetworkImage = true

                val cookieManager = CookieManager.getInstance()
                cookieManager.setAcceptCookie(true)
                cookieManager.setAcceptThirdPartyCookies(webView, true)

                webView.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, pageUrl: String, favicon: android.graphics.Bitmap?) {
                        lastPage = pageUrl
                    }

                    override fun onLoadResource(view: WebView, pageUrl: String) {
                        view.url?.let { if (it.startsWith("http")) lastPage = it }
                    }

                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? {
                        val path = request.url.path?.lowercase().orEmpty()
                        if (found == null && isMedia(path)) {
                            val reqUrl = request.url.toString()
                            val actualReferer = request.requestHeaders["Referer"]?.ifEmpty { null } ?: lastPage
                            val cookies = cookieManager.getCookie(reqUrl)
                                ?: cookieManager.getCookie(actualReferer).orEmpty()

                            found = Triple(reqUrl, actualReferer, cookies)
                            latch.countDown()
                        }
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

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList {
        fun text(i: IntArray) = listOf(CATEGORIES[i[0]].first, REGIONS[i[1]], SORTS[i[2]]).joinToString(" · ")
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("검색어가 없을 때만 적용"),
                CategoryFilter(),
                RegionFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), "드라마 · 전체 · 인기순" to "드라마 · 전체 · 시간순", ::text),
        )
    }

    class CategoryFilter : AnimeFilter.Select<String>("분류", CATEGORIES.map { it.first }.toTypedArray(), DEFAULT_CAT)
    class RegionFilter : AnimeFilter.Select<String>("지역", REGIONS.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "티비룸 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다. 사이트가 새 주소로 넘겨 주면 자동으로 저장됩니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 티비룸 주소 (예: https://tvroom37.org)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://tvroom37.org)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        androidx.preference.SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "접속이 안 되거나 막히면 다음 티비룸 주소(tvroom36 → tvroom37 …)를 찾아 자동 변경합니다."
            setDefaultValue(true)
        }.also(screen::addPreference)
    }

    private fun Response.asDoc(): Document = Jsoup.parse(body.string(), request.url.toString())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val SITE_MARKER = "티비룸"
        private val DISCOVER_LOCK = Any()
        private const val DEFAULT_BASE_URL = "https://tvroom36.org"
        private const val RATE_GAP_MS = 350L
        private const val DEFAULT_UA =
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?tvroom\d+\.[a-z]{2,6}$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?tvroom\d+\.[a-z]{2,6}$""")
        private val NUM_REGEX = Regex("""tvroom(\d+)\.([a-z]{2,6})$""")
        private val EP_NUM_REGEX = Regex("""(\d+(?:\.\d+)?)\s*(?:화|회|부|話)""")
        private val DATE_REGEX = Regex("""(20\d{2})[-.](\d{1,2})[-.](\d{1,2})""")
        private val SHORT_DATE_REGEX = Regex("""(?<!\d)(\d{2})[.]?(\d{2})[.]?(\d{2})(?!\d)""")
        private val LABEL_DATE_REGEX = Regex("""\s*\(?(?:20)?\d{2}[-.]?\d{2}[-.]?\d{2}\)?""")

        private val CATEGORIES = listOf(
            "영화" to "영화",
            "드라마" to "드라마",
            "예능" to "TV예능",
            "음악프로" to "음악프로",
            "애니" to "애니",
            "시사/다큐" to "시사다큐",
        )
        private const val DEFAULT_CAT = 1
        private val REGIONS = listOf("전체", "한국", "외국")
        private val SORTS = listOf("시간순", "인기순")

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "clarity.ms",
            "cloudflareinsights.com",
        )
    }
}
