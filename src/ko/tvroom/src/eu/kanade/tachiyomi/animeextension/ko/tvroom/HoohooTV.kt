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
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import java.io.ByteArrayInputStream
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 후후티비 (hoohootv).
 * 목록: /tv/분류, /movie/분류 (?page=N), 작품: /detail/ID/ (회차는 ?season=S&episode=E),
 * 회차 목록은 작품 페이지의 episodes-data(JSON), 영상은 플레이어(iframe) 안에서 찾고 없으면 숨은 화면(WebView)으로 찾는다.
 */
class HoohooTV : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "후후티비"
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
            return if (DOMAIN_REGEX.matches(custom)) custom else DEFAULT_BASE_URL
        }

    override val client: OkHttpClient = network.client.newBuilder()
        .addInterceptor(PageCache(Regex("^/detail/")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS))
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
    // 주소가 fo.hoohootv459.xyz → fp → fq 처럼 앞 글자가 바뀌거나 숫자가 바뀜.
    // 접속이 안 되거나 막히면 다음 글자·숫자 주소를 차례로 열어 보고, 진짜 후후티비인 주소를 저장해 다시 요청한다.
    private fun autoDomain(): Boolean = prefs()?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

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
        val m = SUBDOMAIN_REGEX.matchEntire(currentHost) ?: return null
        val (first, second, num, tld) = m.destructured
        val n = num.toIntOrNull() ?: return null
        val abc = "abcdefghijklmnopqrstuvwxyz"
        val start = abc.indexOf(second[0])
        // 같은 숫자에서 다음 글자들 → 숫자 +1 ~ +3 에서 같은 글자·다음 글자
        val candidates = (1 until 26).map { "$first${abc[(start + it) % 26]}.hoohootv$n.$tld" } +
            (1..3).flatMap { d -> (0..2).map { "$first${abc[(start + it) % 26]}.hoohootv${n + d}.$tld" } }
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
                        val r = Request.Builder().url("https://$host/home").header("User-Agent", USER_AGENT).build()
                        plain.newCall(r).execute().use { res ->
                            val fh = res.request.url.host
                            val ok = HOST_REGEX.matches(fh) && res.code == 200 &&
                                res.peekBody(300_000).string().contains(SITE_MARKER)
                            if (ok) fh else null
                        }
                    }.getOrNull()
                }
            }
            // 후보 순서대로 (가까운 다음 주소 우선)
            futures.firstNotNullOfOrNull { runCatching { it.get() }.getOrNull() }?.takeIf { it != currentHost }
        } finally {
            pool.shutdown()
        }
    }

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", USER_AGENT)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 목록 =================
    private fun listUrl(path: String, page: Int): String {
        val b = "$baseUrl$path".toHttpUrl().newBuilder()
        if (page > 1) b.addQueryParameter("page", page.toString())
        return b.build().toString()
    }

    // 인기 = 사이트 "인기" 메뉴, 최신 = TV 프로그램 전체(최근 올라온 순)
    override fun popularAnimeRequest(page: Int): Request = GET(listUrl("/popular", page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun latestUpdatesRequest(page: Int): Request = GET(listUrl("/tv/all", page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        DETAIL_REGEX.find(query.trim())?.let { m ->
            return GET("$baseUrl/detail/${m.groupValues[1]}/", h())
        }
        if (query.isNotBlank()) {
            val url = "$baseUrl/search".toHttpUrl().newBuilder()
                .addQueryParameter(searchParam(), query.trim())
                .apply { if (page > 1) addQueryParameter("page", page.toString()) }
                .build()
            return GET(url.toString(), h())
        }
        val cat = filters.filterIsInstance<CategoryFilter>().firstOrNull()?.state ?: 0
        return GET(listUrl(CATEGORIES[cat].second, page), h())
    }

    /** 검색 주소의 검색어 이름 (처음 한 번 맞는 것을 찾아 기억) */
    private fun searchParam(): String {
        prefs()?.getString(PREF_SEARCH_PARAM, null)?.let { return it }
        for (p in SEARCH_PARAMS) {
            val ok = runCatching {
                val url = "$baseUrl/search".toHttpUrl().newBuilder().addQueryParameter(p, "사랑").build()
                client.newCall(GET(url.toString(), h())).execute().use { res ->
                    res.isSuccessful && parseList(Jsoup.parse(res.body.string(), url.toString())).animes.isNotEmpty()
                }
            }.getOrDefault(false)
            if (ok) {
                prefs()?.edit()?.putString(PREF_SEARCH_PARAM, p)?.apply()
                return p
            }
        }
        return SEARCH_PARAMS.first()
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val url = response.request.url
        if (url.encodedPath.startsWith("/detail/")) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { this.url = url.encodedPath }), false)
        }
        return parseList(response.asDoc())
    }

    /** 목록·검색·홈 공통: 작품 링크(/detail/)가 있는 카드 */
    private fun parseList(doc: Document): AnimesPage {
        val seen = HashSet<String>()
        val animes = doc.select("a.thumb[href*=/detail/]").mapNotNull { a ->
            val path = DETAIL_REGEX.find(a.attr("href"))?.let { "/detail/${it.groupValues[1]}/" } ?: return@mapNotNull null
            if (!seen.add(path)) return@mapNotNull null
            val img = a.selectFirst("img")
            val box = a.parent()
            SAnime.create().apply {
                url = path
                title = box?.selectFirst(".subject a")?.text()?.trim()?.ifEmpty { null }
                    ?: img?.attr("alt")?.trim().orEmpty()
                thumbnail_url = img?.let { it.absUrl("data-src").ifEmpty { it.absUrl("src") } }?.ifEmpty { null }
            }
        }.filter { it.title.isNotEmpty() }
        val hasNext = doc.select(".pagination a[href*=page=]").any { it.text().contains("»") } ||
            doc.selectFirst(".pagination .current-page")?.let { cur ->
                val n = cur.text().trim().toIntOrNull() ?: 0
                doc.select(".pagination a[href*=page=]").any { PAGE_REGEX.find(it.attr("href"))?.groupValues?.get(1)?.toIntOrNull() ?: 0 > n }
            } ?: false
        return AnimesPage(animes, hasNext)
    }

    // ================= 작품 정보 =================
    override fun animeDetailsParse(response: Response): SAnime {
        val doc = response.asDoc()
        val episodes = episodesData(doc)
        return SAnime.create().apply {
            title = doc.selectFirst("meta[property=og:title]")?.attr("content")
                ?.substringBeforeLast(" - 후후티비")?.trim()?.ifEmpty { null }
                ?: doc.selectFirst(".share-title h1")?.text()?.substringBefore(" - ")?.trim().orEmpty()
            genre = doc.select(".share-title .datetime-hit a").joinToString(", ") { it.text().trim() }.ifEmpty { null }
            description = doc.selectFirst(".overview")?.text()?.trim()
            if (episodes.isEmpty()) {
                // 영화(회차 없음): 다시 확인할 필요 없음
                status = SAnime.COMPLETED
                update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            } else {
                status = SAnime.UNKNOWN
            }
        }
    }

    /** episodes-data: {"시즌": [{"episode": "1", "date": ..., "label": "1화"}, ...]} → (시즌, 회, 이름, 날짜) */
    private fun episodesData(doc: Document): List<EpisodeInfo> {
        val raw = doc.selectFirst("script#episodes-data")?.data()?.trim().orEmpty()
        if (raw.isEmpty()) return emptyList()
        return runCatching {
            val o = JSONObject(raw)
            o.keys().asSequence().flatMap { s ->
                val arr = o.getJSONArray(s)
                (0 until arr.length()).asSequence().map { i ->
                    val e = arr.getJSONObject(i)
                    EpisodeInfo(
                        season = s.toIntOrNull() ?: 1,
                        episode = e.optString("episode"),
                        label = e.optString("label").ifEmpty { "${e.optString("episode")}화" },
                        date = e.optString("date").takeIf { it != "null" }.orEmpty(),
                    )
                }
            }.toList()
        }.getOrDefault(emptyList())
    }

    private class EpisodeInfo(val season: Int, val episode: String, val label: String, val date: String)

    // ================= 회차 =================
    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val path = response.request.url.encodedPath
        val list = episodesData(doc)
        if (list.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    url = path
                    name = "본편"
                    episode_number = 1f
                },
            )
        }
        val multiSeason = list.map { it.season }.distinct().size > 1
        // 오래된 회차가 1번, 앱에는 최신 회차가 위로
        val sorted = list.sortedWith(compareBy({ it.season }, { it.episode.toFloatOrNull() ?: 0f }))
        return sorted.mapIndexed { i, e ->
            SEpisode.create().apply {
                url = "$path?season=${e.season}&episode=${e.episode}"
                name = if (multiSeason) "시즌${e.season} ${e.label}" else e.label
                episode_number = (i + 1).toFloat()
                date_upload = dateOf(e.date)
            }
        }.reversed()
    }

    private fun dateOf(text: String): Long {
        val m = DATE_REGEX.find(text) ?: return 0L
        return runCatching {
            Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul")).apply {
                clear()
                set(m.groupValues[1].toInt(), m.groupValues[2].toInt() - 1, m.groupValues[3].toInt())
            }.timeInMillis
        }.getOrDefault(0L)
    }

    // ================= 영상 =================
    override fun videoListRequest(episode: SEpisode): Request = GET(baseUrl + episode.url, h())

    override fun videoListParse(response: Response): List<Video> {
        val pageUrl = response.request.url.toString()
        val doc = Jsoup.parse(response.body.string(), pageUrl)
        val player = doc.selectFirst("#iframeContainer iframe, .playstart iframe")?.let { f ->
            f.absUrl("data-src").ifEmpty { f.absUrl("src") }
        }?.takeIf { it.startsWith("http") }
            ?: throw Exception("플레이어를 찾지 못했습니다 (로그인이 필요하거나 영상이 없는 회차일 수 있습니다)")

        // 1) 플레이어 페이지 글자 안에 영상 주소가 있으면 바로, 2) 없으면 숨은 화면으로 열어 영상 요청을 가로챈다
        // jwpcdn 플레이어는 보안 확인(Cloudflare)이 걸려 글자 읽기로는 못 찾으므로 바로 숨은 화면으로 (시간 절약)
        val direct = if (player.contains("jwpcdn")) {
            null
        } else {
            runCatching {
                client.newCall(GET(player, headersBuilder().set("Referer", pageUrl).build())).execute().use { res ->
                    MEDIA_REGEX.find(res.body.string().replace("\\/", "/"))?.value?.let { it to res.request.url.toString() }
                }
            }.getOrNull()
        }
        val directOk = direct?.takeIf { HlsQuality.works(client, it.first, videoHeaders(it.second)) }
        val (media, referer) = directOk ?: sniffWithWebView(player, pageUrl) ?: direct
            ?: throw Exception("영상 주소를 찾지 못했습니다: $player")
        val quality = if (media.contains(".m3u8")) "후후티비 (HLS)" else "후후티비"
        return HlsQuality.sort(prefs(), HlsQuality.expand(client, media, quality, videoHeaders(referer)))
    }

    private fun videoHeaders(referer: String): Headers {
        val origin = referer.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" }
        return Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", referer)
            .apply { if (origin != null) set("Origin", origin) }
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun sniffWithWebView(url: String, referer: String): Pair<String, String>? {
        val latch = CountDownLatch(1)
        var found: Pair<String, String>? = null
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
                webView.settings.mediaPlaybackRequiresUserGesture = false
                webView.settings.userAgentString = USER_AGENT
                // 그림은 받지 않아 영상 주소를 더 빨리 찾음
                webView.settings.blockNetworkImage = true
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, pageUrl: String, favicon: android.graphics.Bitmap?) {
                        lastPage = pageUrl
                    }

                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? {
                        val reqUrl = request.url.toString()
                        if (found == null && MEDIA_REGEX.containsMatchIn(reqUrl)) {
                            found = reqUrl to (request.requestHeaders["Referer"] ?: lastPage)
                            latch.countDown()
                        }
                        // 광고·분석·P2P 추적 요청은 빈 응답으로 막아 로딩을 줄임
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

        latch.await(25, TimeUnit.SECONDS)
        handler.post {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }
        return found
    }

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = AnimeFilterList(
        AnimeFilter.Header("검색어가 없을 때만 적용"),
        CategoryFilter(),
    )

    class CategoryFilter : AnimeFilter.Select<String>("분류", CATEGORIES.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "후후티비 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다. 사이트가 새 주소로 넘겨 주면 자동으로 저장됩니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 후후티비 주소 (예: https://hoohootv1.com)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    prefs()?.edit()?.remove(PREF_SEARCH_PARAM)?.apply()
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://hoohootv1.com)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        androidx.preference.SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "접속이 안 되거나 막히면 다음 후후티비 주소(예: fp → fq → fr…, 숫자가 바뀐 주소)를 찾아 자동 변경합니다."
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    private fun Response.asDoc(): Document = Jsoup.parse(body.string(), request.url.toString())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_SEARCH_PARAM = "pref_search_param"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val SITE_MARKER = "HOOHOO TV"
        private val DISCOVER_LOCK = Any()
        private val SUBDOMAIN_REGEX = Regex("""^([a-z])([a-z])\.hoohootv(\d+)\.([a-z]{2,6})$""")
        private const val DEFAULT_BASE_URL = "https://fp.hoohootv459.xyz"
        private const val RATE_GAP_MS = 350L
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DOMAIN_REGEX = Regex("""^https://(?:[a-z0-9-]+\.)*hoohootv\d*\.[a-z]{2,6}$""")
        private val HOST_REGEX = Regex("""^(?:[a-z0-9-]+\.)*hoohootv\d*\.[a-z]{2,6}$""")
        private val DETAIL_REGEX = Regex("""/detail/([A-Za-z0-9_-]+)""")
        private val PAGE_REGEX = Regex("""[?&]page=(\d+)""")
        private val DATE_REGEX = Regex("""(\d{4})[-.](\d{1,2})[-.](\d{1,2})""")
        private val MEDIA_REGEX = Regex(
            """https?://[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?""",
            RegexOption.IGNORE_CASE,
        )
        private val SEARCH_PARAMS = listOf("q", "query", "keyword", "search", "s")

        private val CATEGORIES = listOf(
            "TV 전체" to "/tv/all",
            "TV - 드라마" to "/tv/%EB%93%9C%EB%9D%BC%EB%A7%88",
            "TV - 예능" to "/tv/Reality",
            "TV - 코미디" to "/tv/%EC%BD%94%EB%AF%B8%EB%94%94",
            "TV - 액션" to "/tv/Action%20%26%20Adventure",
            "TV - 판타지" to "/tv/Sci-Fi%20%26%20Fantasy",
            "TV - 범죄" to "/tv/%EB%B2%94%EC%A3%84",
            "TV - 미스터리" to "/tv/%EB%AF%B8%EC%8A%A4%ED%84%B0%EB%A6%AC",
            "TV - 애니메이션" to "/tv/%EC%95%A0%EB%8B%88%EB%A9%94%EC%9D%B4%EC%85%98",
            "TV - 다큐멘터리" to "/tv/%EB%8B%A4%ED%81%90%EB%A9%98%ED%84%B0%EB%A6%AC",
            "TV - 가족" to "/tv/%EA%B0%80%EC%A1%B1",
            "TV - 토크쇼" to "/tv/Talk",
            "TV - 전쟁과 정치" to "/tv/War%20%26%20Politics",
            "TV - 키즈" to "/tv/Kids",
            "TV - 서부" to "/tv/%EC%84%9C%EB%B6%80",
            "영화 전체" to "/movie/all",
            "영화 - 액션" to "/movie/%EC%95%A1%EC%85%98",
            "영화 - 코미디" to "/movie/%EC%BD%94%EB%AF%B8%EB%94%94",
            "영화 - SF" to "/movie/SF",
            "영화 - 스릴러" to "/movie/%EC%8A%A4%EB%A6%B4%EB%9F%AC",
            "영화 - 로맨스" to "/movie/%EB%A1%9C%EB%A7%A8%EC%8A%A4",
            "영화 - 공포" to "/movie/%EA%B3%B5%ED%8F%AC",
            "영화 - 범죄" to "/movie/%EB%B2%94%EC%A3%84",
            "영화 - 모험" to "/movie/%EB%AA%A8%ED%97%98",
            "영화 - 판타지" to "/movie/%ED%8C%90%ED%83%80%EC%A7%80",
            "영화 - 미스터리" to "/movie/%EB%AF%B8%EC%8A%A4%ED%84%B0%EB%A6%AC",
            "영화 - 애니메이션" to "/movie/%EC%95%A0%EB%8B%88%EB%A9%94%EC%9D%B4%EC%85%98",
            "영화 - 가족" to "/movie/%EA%B0%80%EC%A1%B1",
            "영화 - 음악" to "/movie/%EC%9D%8C%EC%95%85",
            "영화 - 역사" to "/movie/%EC%97%AD%EC%82%AC",
            "영화 - 다큐멘터리" to "/movie/%EB%8B%A4%ED%81%90%EB%A9%98%ED%84%B0%EB%A6%AC",
            "영화 - 전쟁" to "/movie/%EC%A0%84%EC%9F%81",
            "영화 - 서부" to "/movie/%EC%84%9C%EB%B6%80",
        )

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "cloudflareinsights.com",
            "jwpltx.com",
            "btorrent.xyz",
        )
    }
}
