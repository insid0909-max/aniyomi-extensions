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
import org.json.JSONArray
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 미미티비 (mimitv).
 * 목록: /show.php?tid=분류&class=장르&order_type=정렬&limit=24&page=N, 검색: /search.php?keyword=,
 * 작품·재생: /shplay.php?id=N (회차는 페이지 안 manualSeasons). 영상 주소는 플레이어 페이지가
 * 실행되면서 정해지므로 숨은 화면(WebView)으로 플레이어를 열어 영상 요청을 받는다.
 */
class MimiTV : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "미미티비"
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
        .addInterceptor(PageCache(Regex("^/shplay\\.php")))
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
        .addInterceptor(NoticeFollow(HOST_REGEX, "shplay.php"))
        .addInterceptor(RetryOnce(HOST_REGEX))
        .build()

    // ================= 도메인 자동 찾기 =================
    // 주소가 mimitv7.com → mimitv8.com 처럼 숫자가 바뀜. 접속이 안 되거나 막히면 다음 숫자 주소를 열어 보고,
    // 진짜 미미티비인 주소를 저장해 다시 요청한다.
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
        val n = NUM_REGEX.find(currentHost)?.groupValues?.get(1)?.toIntOrNull() ?: return null
        // 다음 숫자 우선, 그다음 이전 숫자
        val candidates = (1..8).map { "mimitv${n + it}.com" } + (1..2).mapNotNull { (n - it).takeIf { v -> v > 0 }?.let { v -> "mimitv$v.com" } }
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
                        val r = Request.Builder().url("https://$host/").header("User-Agent", USER_AGENT).build()
                        plain.newCall(r).execute().use { res ->
                            val fh = res.request.url.host
                            val ok = HOST_REGEX.matches(fh) && res.code == 200 &&
                                res.peekBody(300_000).string().contains("shplay.php")
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

    // ================= 목록 =================
    private fun listUrl(cat: Int, genre: Int, sort: Int, page: Int): String {
        val b = "$baseUrl/show.php".toHttpUrl().newBuilder()
        CATEGORIES.getOrNull(cat)?.second?.takeIf { it.isNotEmpty() }?.let { b.addQueryParameter("tid", it) }
        if (genre > 0) GENRES.getOrNull(genre)?.let { b.addQueryParameter("class", it) }
        b.addQueryParameter("order_type", SORTS.getOrNull(sort)?.second.orEmpty())
        if (page > 1) {
            b.addQueryParameter("limit", "24")
            b.addQueryParameter("page", page.toString())
        }
        return b.build().toString()
    }

    private fun ruleSizes() = intArrayOf(CATEGORIES.size, GENRES.size, SORTS.size)

    private fun savedRule(popular: Boolean, page: Int): Request? =
        TabRule.read(prefs(), popular, ruleSizes())?.let { GET(listUrl(it[0], it[1], it[2], page), h()) }

    // 기본: 인기 = 드라마 인기순, 최신 = 드라마 최신순 (필터의 "인기/최신 탭 규칙"으로 바꿀 수 있음)
    override fun popularAnimeRequest(page: Int): Request = savedRule(true, page) ?: GET(listUrl(DEFAULT_CAT, 0, 1, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun latestUpdatesRequest(page: Int): Request = savedRule(false, page) ?: GET(listUrl(DEFAULT_CAT, 0, 0, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        // 작품 주소를 붙여 넣으면 그 작품을 바로 열기
        ID_REGEX.find(query.trim())?.let { m -> return GET("$baseUrl/shplay.php?id=${m.groupValues[1]}", h()) }
        if (query.isNotBlank()) {
            val url = "$baseUrl/search.php".toHttpUrl().newBuilder()
                .addQueryParameter("keyword", query.trim())
                .apply {
                    if (page > 1) {
                        addQueryParameter("limit", "24")
                        addQueryParameter("page", page.toString())
                    }
                }
                .build()
            return GET(url.toString(), h())
        }
        val cat = filters.filterIsInstance<CategoryFilter>().firstOrNull()?.state ?: DEFAULT_CAT
        val genre = filters.filterIsInstance<GenreFilter>().firstOrNull()?.state ?: 0
        val sort = filters.filterIsInstance<SortFilter>().firstOrNull()?.state ?: 0
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let {
            TabRule.apply(prefs(), it.state, intArrayOf(cat, genre, sort))
        }
        return GET(listUrl(cat, genre, sort, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val url = response.request.url
        if (url.encodedPath.startsWith("/shplay.php")) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { this.url = "/shplay.php?id=${url.queryParameter("id")}" }), false)
        }
        return parseList(response.asDoc())
    }

    /** 목록·검색 공통: 작품 카드 (div.item) */
    private fun parseList(doc: Document): AnimesPage {
        val seen = HashSet<String>()
        val animes = doc.select("div.item").mapNotNull { item ->
            val a = item.selectFirst("a.poster[href*=shplay.php], a.title[href*=shplay.php]") ?: return@mapNotNull null
            val id = ID_REGEX.find(a.attr("href"))?.groupValues?.get(1) ?: return@mapNotNull null
            if (!seen.add(id)) return@mapNotNull null
            SAnime.create().apply {
                url = "/shplay.php?id=$id"
                title = item.selectFirst("h3 a.title, .entry-title a")?.text()?.trim()
                    ?: item.selectFirst("img")?.attr("alt")?.trim().orEmpty()
                thumbnail_url = item.selectFirst("img")?.let { img -> img.absUrl("data-src").ifEmpty { img.absUrl("src") } }
                    ?.takeUnless { it.startsWith("data:") }
                description = item.selectFirst(".tooltip_templates .desc")?.text()?.trim()
            }
        }
        // 다음 쪽: 현재 쪽 표시(li.active) 뒤에 쪽 번호 링크가 더 있으면
        val hasNext = doc.selectFirst("ul.pagination li.active ~ li a[href*=page=]")?.text()?.trim()?.toIntOrNull() != null
        return AnimesPage(animes, hasNext)
    }

    // ================= 작품 정보 =================
    override fun animeDetailsParse(response: Response): SAnime {
        val doc = response.asDoc()
        val info = doc.selectFirst("section.info, .watch-extra")
        val genres = metaValue(info, "장르")
        val seasons = seasonsOf(doc)
        val epCount = seasons.sumOf { it.size }
        return SAnime.create().apply {
            title = info?.selectFirst("h1.entry-title, h1.title")?.text()?.trim().orEmpty()
            thumbnail_url = info?.selectFirst(".poster img")?.let { img -> img.absUrl("data-src").ifEmpty { img.absUrl("src") } }
                ?.takeUnless { it.startsWith("data:") }
            description = info?.selectFirst(".desc")?.text()?.trim()
            genre = genres?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }?.joinToString(", ")?.ifEmpty { null }
            val isMovie = genres?.contains("영화") == true || (epCount <= 1 && seasons.firstOrNull()?.firstOrNull()?.label?.contains("화") != true)
            when {
                isMovie -> {
                    status = SAnime.COMPLETED
                    update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
                }
                // 장르에 방송 요일(월화·수목 등)이 있으면 방영 중
                genres != null && AIRING_REGEX.containsMatchIn(genres) -> status = SAnime.ONGOING
                else -> status = SAnime.UNKNOWN
            }
        }
    }

    /** "국가:", "장르:" 같은 항목 값 */
    private fun metaValue(root: org.jsoup.nodes.Element?, key: String): String? = root?.select(".meta > div")
        ?.firstOrNull { it.selectFirst("span")?.text()?.contains(key) == true }
        ?.select("span")?.drop(1)?.joinToString(" ") { it.text().trim() }?.trim()?.ifEmpty { null }

    private class Ep(val label: String, val links: List<Pair<String, String>>)

    /** manualSeasons: [{"e":[{"link_1":..., "host_1":"제1화", "link_2":...}, ...]}, ...] */
    private fun seasonsOf(doc: Document): List<List<Ep>> {
        val json = doc.select("script").firstNotNullOfOrNull { SEASONS_REGEX.find(it.data())?.groupValues?.get(1) }
            ?: return emptyList()
        return runCatching {
            val arr = JSONArray(json)
            (0 until arr.length()).map { s ->
                val eps = arr.getJSONObject(s).optJSONArray("e") ?: JSONArray()
                (0 until eps.length()).map { i ->
                    val o = eps.getJSONObject(i)
                    val links = (1..3).mapNotNull { k ->
                        val link = o.optString("link_$k").trim()
                        if (link.startsWith("http")) link to o.optString("host_$k").trim() else null
                    }
                    Ep(o.optString("host_1").trim(), links)
                }
            }
        }.getOrDefault(emptyList())
    }

    // ================= 회차 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val id = response.request.url.queryParameter("id") ?: return emptyList()
        val seasons = seasonsOf(doc)
        val multiSeason = seasons.size > 1
        val list = ArrayList<SEpisode>()
        var seq = 0
        seasons.forEachIndexed { s, eps ->
            eps.forEachIndexed { e, ep ->
                seq++
                val num = EP_NUM_REGEX.find(ep.label)?.groupValues?.get(1)
                // "제12화" → "12화", 영화는 "본편"
                val base = when {
                    num != null -> "${num}화"
                    eps.size == 1 && seasons.size == 1 -> "본편"
                    else -> ep.label.ifEmpty { "${e + 1}화" }
                }
                list.add(
                    SEpisode.create().apply {
                        url = "/shplay.php?id=$id&ep=${s}_$e"
                        name = if (multiSeason) "시즌${s + 1} $base" else base
                        // 앱 안에서 겹치지 않는 차례 번호 (오래된 회차가 1번)
                        episode_number = seq.toFloat()
                    },
                )
            }
        }
        return list.reversed()
    }

    // ================= 영상 =================
    override fun videoListRequest(episode: SEpisode): Request = GET(baseUrl + episode.url, h())

    override fun videoListParse(response: Response): List<Video> {
        val pageUrl = response.request.url
        val doc = Jsoup.parse(response.body.string(), pageUrl.toString())
        val (s, e) = (pageUrl.queryParameter("ep") ?: "0_0").split("_").map { it.toIntOrNull() ?: 0 }
            .let { it.getOrElse(0) { 0 } to it.getOrElse(1) { 0 } }
        val ep = seasonsOf(doc).getOrNull(s)?.getOrNull(e)
            ?: throw Exception("회차 정보를 찾지 못했습니다 (사이트 회차 목록이 바뀌었을 수 있습니다. 회차 목록을 새로고침해 주세요)")
        if (ep.links.isEmpty()) throw Exception("이 회차에는 재생 주소가 없습니다")

        // 서버(링크)를 차례로 열어 보고, 영상이 나오는 첫 번째를 사용
        val siteRef = "$baseUrl/"
        for ((link, _) in ep.links) {
            val found = sniffWithWebView(link, siteRef) ?: continue
            val (media, referer) = found
            val quality = if (media.contains(".m3u8")) "미미티비 (HLS)" else "미미티비"
            return HlsQuality.sort(prefs(), HlsQuality.expand(client, media, quality, videoHeaders(referer)))
        }
        throw Exception("영상 주소를 찾지 못했습니다: ${ep.links.first().first}")
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
        // 플레이어 주소 안에 적힌 영상 주소(url=…)는 실제로는 열리지 않는 주소라 제외
        val decoy = url.toHttpUrlOrNull()?.queryParameter("url")

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

                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? {
                        val reqUrl = request.url.toString()
                        val path = request.url.path?.lowercase().orEmpty()
                        if (found == null && (path.endsWith(".m3u8") || path.endsWith(".mp4")) && reqUrl != decoy) {
                            found = reqUrl to (request.requestHeaders["Referer"] ?: lastPage)
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
            // 재생을 눌러야만 영상 주소를 받는 플레이어: 자동 재생을 켜고 다시 열어 봄
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
        fun text(i: IntArray) = listOfNotNull(
            CATEGORIES[i[0]].first,
            GENRES[i[1]].takeIf { i[1] > 0 },
            SORTS[i[2]].first,
        ).joinToString(" · ")
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("검색어가 없을 때만 적용"),
                CategoryFilter(),
                GenreFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), "드라마 · 인기순" to "드라마 · 최신순", ::text),
        )
    }

    class CategoryFilter : AnimeFilter.Select<String>("분류", CATEGORIES.map { it.first }.toTypedArray(), DEFAULT_CAT)
    class GenreFilter : AnimeFilter.Select<String>("장르", GENRES.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "미미티비 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다. 사이트가 새 주소로 넘겨 주면 자동으로 저장됩니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 미미티비 주소 (예: https://mimitv8.com)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://mimitv8.com)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        androidx.preference.SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "접속이 안 되거나 막히면 다음 미미티비 주소(mimitv7 → mimitv8 …)를 찾아 자동 변경합니다."
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    private fun Response.asDoc(): Document = Jsoup.parse(body.string(), request.url.toString())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private val DISCOVER_LOCK = Any()
        private const val DEFAULT_BASE_URL = "https://mimitv9.com"
        private const val RATE_GAP_MS = 350L
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?mimitv\d+\.com$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?mimitv\d+\.com$""")
        private val NUM_REGEX = Regex("""mimitv(\d+)\.com""")
        private val ID_REGEX = Regex("""shplay\.php\?id=(\d+)""")
        private val SEASONS_REGEX = Regex("""manualSeasons\s*=\s*(\[[\s\S]*?\])\s*;""")
        private val EP_NUM_REGEX = Regex("""(\d+(?:\.\d+)?)\s*화""")
        private val AIRING_REGEX = Regex("""월화|수목|금토|토일|일일|주말|매일|월요|화요|수요|목요|금요|토요|일요""")

        /** 분류 이름 → tid (빈 값 = 전체) */
        private val CATEGORIES = listOf(
            "전체" to "",
            "영화" to "1",
            "한국영화" to "40",
            "해외영화" to "41",
            "드라마" to "2",
            "한국드라마" to "42",
            "해외드라마" to "43",
            "숏드라마" to "44",
            "예능" to "3",
            "시사다큐" to "4",
            "애니" to "5",
        )
        private const val DEFAULT_CAT = 4

        /** 장르 (사이트 메뉴의 장르 목록, 0 = 전체) */
        private val GENRES = listOf(
            "전체", "스릴러", "액션", "범죄", "코미디", "로맨스", "공포", "미스터리", "다큐멘터리", "서사",
            "SF", "판타지", "가족", "전쟁", "모험", "웹드라마", "요리", "시상식", "버라이어티", "공연",
        )

        private val SORTS = listOf("최신순" to "", "인기순" to "vod_hits")

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "shinystat.com",
            "waust.at",
            "cokcok.stream",
        )
    }
}
