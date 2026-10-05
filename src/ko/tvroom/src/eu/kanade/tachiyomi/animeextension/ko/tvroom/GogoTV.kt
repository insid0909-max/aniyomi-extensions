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
import androidx.preference.SwitchPreferenceCompat
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
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
import java.io.ByteArrayInputStream
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 고고티비 (gogotv숫자.xyz) */
class GogoTV : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "고고티비"
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

    private fun autoDomain(): Boolean = prefs()?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

    private fun saveDomain(url: String) {
        prefs()?.edit()?.putString(PREF_DOMAIN_KEY, url)?.apply()
    }

    // 주소 번호가 바뀌어 접속이 안 되면 gogotv 번호 주소를 찾아 자동 연결
    override val client: OkHttpClient = network.client.newBuilder()
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS))
        .addInterceptor { chain -> domainIntercept(chain) }
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", USER_AGENT)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 도메인 자동 찾기 =================
    private fun isDead(res: Response): Boolean {
        if (!HOST_REGEX.matches(res.request.url.host)) return true
        return res.code == 403 || res.code == 451 || res.code >= 500
    }

    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val baseHost = baseUrl.toHttpUrlOrNull()?.host
        if (baseHost == null || req.url.host != baseHost || !autoDomain()) return chain.proceed(req)

        fun retryOn(found: String): Response {
            saveDomain("https://$found")
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(found).build()).build())
        }

        val res = try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            val found = discoverDomain(baseHost) ?: throw e
            return retryOn(found)
        }

        if (req.method == "GET" && isDead(res)) {
            val found = discoverDomain(baseHost) ?: return res
            res.close()
            return retryOn(found)
        }

        // 사이트가 스스로 새 주소로 넘겨 준 경우 그 주소를 저장
        val finalHost = res.request.url.host
        if (finalHost != baseHost && HOST_REGEX.matches(finalHost)) saveDomain("https://$finalHost")
        return res
    }

    @Volatile private var lastDiscover = 0L

    private fun hostNumber(host: String): Int =
        NUMBER_REGEX.find(host)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    // gogotv 번호 주소를 현재 번호 -5 ~ +30 범위에서 동시에 열어 보고, 실제 고고티비인 가장 큰 번호를 고른다
    private fun discoverDomain(currentHost: String): String? = synchronized(DISCOVER_LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now

        val cur = hostNumber(currentHost).takeIf { it > 0 } ?: hostNumber(DEFAULT_BASE_URL)
        val plain = OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
        val pool = Executors.newFixedThreadPool(12)
        try {
            val futures = ((cur - 5).coerceAtLeast(1)..(cur + 30))
                .map { "gogotv$it.xyz" }
                .map { host ->
                    pool.submit<String?> {
                        try {
                            val r = Request.Builder().url("https://$host/").header("User-Agent", USER_AGENT).build()
                            plain.newCall(r).execute().use { res ->
                                val fh = res.request.url.host
                                val ok = HOST_REGEX.matches(fh) && res.code == 200 &&
                                    res.peekBody(300_000).string().contains(SITE_MARKER, ignoreCase = true)
                                if (ok) fh else null
                            }
                        } catch (e: Exception) {
                            null
                        }
                    }
                }
            // 지금 주소가 가장 좋은 주소면 바꾸지 않음
            futures.mapNotNull { it.get() }.maxByOrNull { hostNumber(it) }?.takeIf { it != currentHost }
        } finally {
            pool.shutdown()
        }
    }

    // ================= 목록 =================
    private fun listUrl(cat: String, sort: String, country: String, page: Int): String {
        val b = "$baseUrl/$cat".toHttpUrl().newBuilder()
        if (country.isNotEmpty()) b.addQueryParameter("country", country)
        if (sort.isNotEmpty()) b.addQueryParameter("o", sort)
        if (page > 1) b.addQueryParameter("page", page.toString())
        return b.build().toString()
    }

    // 인기/최신 탭: 필터에서 저장한 조건이 있으면 그 조건으로, 없으면 기본 목록
    override fun popularAnimeRequest(page: Int): Request =
        TabRule.read(prefs(), true, RULE_SIZES)?.let { filterRequest(page, it) }
            ?: GET(listUrl("list-drama", "2", "", page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun latestUpdatesRequest(page: Int): Request =
        TabRule.read(prefs(), false, RULE_SIZES)?.let { filterRequest(page, it) }
            ?: GET(listUrl("list-drama", "1", "", page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        // 사이트 작품 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
        URL_PLAYER_REGEX.find(query.trim())?.let { m ->
            return GET("$baseUrl/player/${m.groupValues[1]}", h())
        }
        if (query.isNotBlank()) {
            val url = "$baseUrl/search/".toHttpUrl().newBuilder()
                .addQueryParameter(SEARCH_PARAMS.first(), query.trim())
                .apply { if (page > 1) addQueryParameter("page", page.toString()) }
                .build()
            return GET(url.toString(), h())
        }
        val idx = IntArray(RULE_SIZES.size)
        var rule = 0
        filters.forEach { f ->
            when (f) {
                is CategoryFilter -> idx[0] = f.state
                is SortFilter -> idx[1] = f.state
                is CountryFilter -> idx[2] = f.state
                is TabRule.RuleFilter -> rule = f.state
                else -> {}
            }
        }
        TabRule.apply(prefs(), rule, idx)
        return filterRequest(page, idx)
    }

    /** idx = [분류, 정렬, 지역] 선택 번호 */
    private fun filterRequest(page: Int, idx: IntArray): Request =
        GET(listUrl(CATEGORIES[idx[0]].second, SORTS[idx[1]].second, COUNTRIES[idx[2]].second, page), h())

    override fun searchAnimeParse(response: Response): AnimesPage {
        val url = response.request.url
        if (url.encodedPath.startsWith("/player/")) {
            // 주소로 찾은 작품 하나
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { this.url = url.encodedPath }), false)
        }
        val result = parseList(response.asDoc())
        val query = url.queryParameter(SEARCH_PARAMS.first())
        if (result.animes.isNotEmpty() || query == null || url.encodedPath != "/search/") return result

        // 검색 주소의 이름표(파라미터)가 다르면 다른 이름으로 다시 시도
        for (param in SEARCH_PARAMS.drop(1)) {
            val retry = url.newBuilder().removeAllQueryParameters(SEARCH_PARAMS.first())
                .addQueryParameter(param, query).build()
            val page = runCatching {
                client.newCall(GET(retry.toString(), h())).execute().use { parseList(it.asDoc()) }
            }.getOrNull()
            if (page != null && page.animes.isNotEmpty()) return page
        }
        return result
    }

    private fun parseList(doc: Document): AnimesPage {
        val seen = HashSet<String>()
        val animes = doc.select(".itemLish-cont dl, .modList-ul dl, .view-floor3 .item dl").mapNotNull { dl ->
            val a = dl.selectFirst("a[href*=/player/]") ?: return@mapNotNull null
            val path = pathOf(a.attr("href"))
            if (!seen.add(path)) return@mapNotNull null
            val img = dl.selectFirst("img")
            SAnime.create().apply {
                url = path
                title = dl.selectFirst(".tit")?.text()?.trim()?.ifEmpty { null }
                    ?: img?.attr("alt")?.trim().orEmpty()
                thumbnail_url = img?.absUrl("src")?.ifEmpty { null }
                // 방영 중이면 제목 뒤에 최근 방영일 (겹치는 "(2026)" 연도는 뺌),
                // 방영이 끝났으면 제목 뒤에 연도 (사이트 제목에 없으면 마지막 방영 연도)
                val date = dl.selectFirst(".date")?.text().orEmpty()
                val air = airLabel(date)
                if (title.isNotEmpty() && air != null) {
                    title = "${title.replace(TITLE_YEAR_REGEX, "")} · $air"
                } else if (title.isNotEmpty() && !TITLE_YEAR_REGEX.containsMatchIn(title)) {
                    CARD_DATE_REGEX.find(date)?.let { title = "$title (20${it.groupValues[1]})" }
                }
            }
        }.filter { it.title.isNotEmpty() }
        return AnimesPage(animes, hasNextPage(doc))
    }

    /**
     * 카드의 "제19회 26/10/04" · "E344 26/10/04" 에서 최근 방영일을 "10.04" 로.
     * 최종회이거나 마지막 방영이 오래된(종영으로 보이는) 작품은 붙이지 않음
     */
    private fun airLabel(date: String): String? {
        if (date.contains("최종")) return null
        val m = CARD_DATE_REGEX.find(date) ?: return null
        val at = dateOf(date).takeIf { it > 0 } ?: return null
        if (System.currentTimeMillis() - at > ONGOING_DAYS * 86_400_000L) return null
        return "${m.groupValues[2]}.${m.groupValues[3]}"
    }

    /** "제19회 26/10/04" → 한국시간 그날 0시 (없으면 0) */
    private fun dateOf(text: String): Long {
        val (yy, mm, dd) = CARD_DATE_REGEX.find(text)?.destructured ?: return 0L
        return runCatching {
            Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul")).apply {
                clear()
                set(2000 + yy.toInt(), mm.toInt() - 1, dd.toInt())
            }.timeInMillis
        }.getOrDefault(0L)
    }

    private fun hasNextPage(doc: Document): Boolean {
        val cur = doc.selectFirst(".paging a.on")?.text()?.trim()?.toIntOrNull() ?: return false
        val max = doc.select(".paging a[href]").mapNotNull {
            PAGE_REGEX.find(it.attr("href"))?.groupValues?.get(1)?.toIntOrNull()
        }.maxOrNull() ?: return false
        return max > cur
    }

    // ================= 상세 =================
    override fun animeDetailsParse(response: Response): SAnime {
        val doc = response.asDoc()
        return SAnime.create().apply {
            val name = doc.selectFirst(".view-floor2-lf-cont .tit")?.text()?.trim()
                ?: doc.selectFirst(".view-floor2-tit")?.ownText()?.trim().orEmpty()
            // 제목: 방영 중(방영 기간에 "예정")이면 연도 없이, 끝났으면 연도 (사이트 제목에 없으면 방영 시작 연도)
            // — 애니요미는 서재에 담을 때의 제목을 계속 쓰므로 바뀌는 방영일은 넣지 않음
            val periodText = doc.select(".view-floor2-lf-cont .list .right").map { it.text() }.firstOrNull { it.contains("~") }
            val startYear = periodText?.let { PERIOD_YEAR_REGEX.find(it)?.groupValues?.get(1) }
            title = when {
                periodText != null && periodText.contains("예정") -> name.replace(TITLE_YEAR_REGEX, "")
                startYear != null && !TITLE_YEAR_REGEX.containsMatchIn(name) -> "$name ($startYear)"
                else -> name
            }
            thumbnail_url = doc.selectFirst(".view-floor2-lf-img img")?.absUrl("src")?.ifEmpty { null }
            val info = doc.select(".view-floor2-lf-cont .list .right").map { it.text().trim() }
                .filter { it.isNotEmpty() }
            val plot = doc.selectFirst(".view-floor2-lf-cont .cont")?.text()?.trim().orEmpty()
            // 방영 기간 "2026년 7월 25일 ~ 2027년 1월 10일 (예정)" 과 회차 날짜로 방영 중/종영 판단
            val period = info.firstOrNull { it.contains("~") }
            val latest = doc.select(".view-floor1-rt-cont li p.left a").map { dateOf(it.text()) }.maxOrNull() ?: 0L
            status = when {
                period != null && period.contains("예정") -> SAnime.ONGOING
                period != null -> SAnime.COMPLETED
                else -> SAnime.UNKNOWN
            }
            val head = if (latest > 0) {
                val fmt = java.text.SimpleDateFormat("yyyy.MM.dd (E)", java.util.Locale.KOREAN)
                    .apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }
                val st = when (status) {
                    SAnime.ONGOING -> "방영 중 · "
                    SAnime.COMPLETED -> "종영 · "
                    else -> ""
                }
                "${st}최근 방영: ${fmt.format(java.util.Date(latest))}"
            } else {
                ""
            }
            description = (listOf(head) + info.filterNot { it.contains(",") } + listOf(plot))
                .filter { it.isNotEmpty() }.joinToString("\n\n")
            author = doc.select(".view-floor2-lf-cont .list .blue a").joinToString(", ") { it.text().trim() }
                .ifEmpty { null }
        }
    }

    // ================= 회차 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val links = doc.select(".view-floor1-rt-cont li").mapNotNull { li ->
            val a = li.selectFirst("p.left a[href]") ?: li.selectFirst("a[href]") ?: return@mapNotNull null
            val href = a.absUrl("href").ifEmpty { return@mapNotNull null }
            // 아이콘 글꼴 문자 제거
            href to a.text().replace(ICON_REGEX, "").trim().ifEmpty { "바로보기" }
        }.distinctBy { it.first }

        return links.mapIndexed { i, (href, label) ->
            SEpisode.create().apply {
                url = href
                name = label
                date_upload = dateOf(label)
                episode_number = EP_REGEX.find(label)?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }
                    ?.toFloatOrNull() ?: (links.size - i).toFloat()
            }
        }
    }

    override fun getEpisodeUrl(episode: SEpisode): String = episode.url

    // ================= 영상 =================
    override fun videoListRequest(episode: SEpisode): Request =
        GET(episode.url, headersBuilder().set("Referer", "$baseUrl/").build())

    override fun videoListParse(response: Response): List<Video> {
        val pageUrl = response.request.url.toString()
        val html = response.body.string()

        // 1) 페이지나 그 안 iframe 에 영상 주소가 그대로 들어 있는 경우
        val direct = findMedia(html) ?: Jsoup.parse(html, pageUrl).select("iframe[src]")
            .map { it.absUrl("src") }.filter { it.startsWith("http") }
            .firstNotNullOfOrNull { src ->
                runCatching {
                    client.newCall(GET(src, headersBuilder().set("Referer", pageUrl).build())).execute()
                        .use { findMedia(it.body.string()) }
                }.getOrNull()
            }

        // 2) 없으면 숨은 화면(WebView)으로 열어 영상 요청을 가로챈다
        val (media, referer) = direct?.let { it to pageUrl } ?: sniffWithWebView(pageUrl)
            ?: throw Exception("영상 주소를 찾지 못했습니다: $pageUrl")

        val origin = referer.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" }
        val vh = Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", referer)
            .apply { if (origin != null) set("Origin", origin) }
            .build()
        val quality = if (media.contains(".m3u8")) "고고티비 (HLS)" else "고고티비"
        return HlsQuality.sort(prefs(), HlsQuality.expand(client, media, quality, vh))
    }

    private fun findMedia(text: String): String? =
        MEDIA_REGEX.find(text.replace("\\/", "/"))?.value

    @SuppressLint("SetJavaScriptEnabled")
    private fun sniffWithWebView(url: String): Pair<String, String>? {
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
                            val ref = request.requestHeaders["Referer"] ?: lastPage
                            found = reqUrl to ref
                            latch.countDown()
                        }
                        // 광고/분석 스크립트는 빈 응답으로 막아 로딩을 줄임
                        if (BLOCKED_HOSTS.any { request.url.host?.endsWith(it) == true }) {
                            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }
                webView.loadUrl(url, mapOf("Referer" to "$baseUrl/"))
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
    override fun getFilterList(): AnimeFilterList = ExtStatus.prepend(
        "gogotv",
        baseUrl,
        autoDomain(),
        AnimeFilterList(
            AnimeFilter.Header("검색어가 없을 때만 적용"),
            CategoryFilter(),
            SortFilter(),
            CountryFilter(),
            *TabRule.filters(prefs(), RULE_SIZES, "드라마 · 주간인기순" to "드라마 · 업데이트순") {
                "${CATEGORIES[it[0]].first} · ${SORTS[it[1]].first} · ${COUNTRIES[it[2]].first}"
            }.toTypedArray(),
        ),
    )

    class CategoryFilter : AnimeFilter.Select<String>("분류", CATEGORIES.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())
    class CountryFilter : AnimeFilter.Select<String>("지역", COUNTRIES.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        fun summaryOf(current: String) = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다.\n현재 주소: $current"

        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "고고티비 주소 직접 지정 (선택)"
            summary = summaryOf(baseUrl)
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "gogotv숫자.xyz 형식의 HTTPS 주소만 허용됩니다."
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                when {
                    input.isEmpty() -> {
                        summary = summaryOf(DEFAULT_BASE_URL)
                        true
                    }
                    DOMAIN_REGEX.matches(input) -> {
                        summary = summaryOf(input)
                        Toast.makeText(ctx, "주소가 변경되었습니다: $input", Toast.LENGTH_SHORT).show()
                        true
                    }
                    else -> {
                        Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://gogotv2.xyz)", Toast.LENGTH_LONG).show()
                        false
                    }
                }
            }
        }.also(screen::addPreference)

        SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "접속이 안 되거나 막히면 gogotv 번호 주소(현재 번호 -5 ~ +30)를 찾아 자동 변경합니다."
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    // ================= 공용 =================
    private fun pathOf(href: String): String = PATH_REGEX.find(href)?.groupValues?.get(1) ?: href

    private fun Response.asDoc(): Document = Jsoup.parse(body.string(), request.url.toString())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val DEFAULT_BASE_URL = "https://gogotv2.xyz"
        private const val SITE_MARKER = "gogoTV"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DISCOVER_LOCK = Any()

        private val DOMAIN_REGEX = Regex("""^https://gogotv\d+\.xyz$""")
        private val HOST_REGEX = Regex("""^gogotv\d+\.xyz$""")
        private val NUMBER_REGEX = Regex("""gogotv(\d+)\.xyz""")
        private val PATH_REGEX = Regex("""^https?://[^/]+(/.*)$""")
        private val PAGE_REGEX = Regex("""[?&]page=(\d+)""")
        private val EP_REGEX = Regex("""제\s*(\d+)\s*회|E(\d+)""")
        private val MEDIA_REGEX = Regex(
            """https?://[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?""",
            RegexOption.IGNORE_CASE,
        )

        // 검색 파라미터 이름 후보 (앞에서부터 시도)
        private val SEARCH_PARAMS = listOf("stx", "q", "keyword", "kwd", "search")

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "waust.at",
            "51.la",
            "cloudflareinsights.com",
        )

        private val CATEGORIES = listOf(
            "드라마" to "list-drama",
            "영화" to "list-movie",
            "예능" to "list-vraiety",
            "TV프로" to "list-tvshow",
            "음악프로" to "list-music",
            "애니" to "list-animation",
        )
        private val SORTS = listOf(
            "업데이트순" to "1",
            "주간인기순" to "2",
            "월간인기순" to "3",
            "전체인기순" to "4",
        )
        private val COUNTRIES = listOf(
            "전체" to "",
            "한국" to "1",
            "미국" to "2",
            "중국" to "3",
            "홍콩" to "4",
            "대만" to "5",
            "일본" to "6",
            "영국" to "7",
            "프랑스" to "8",
        )
        private val CARD_DATE_REGEX = Regex("""(\d{2})/(\d{2})/(\d{2})""")
        private const val ONGOING_DAYS = 21
        private const val RATE_GAP_MS = 350L
        private val ICON_REGEX = Regex("[\\uE000-\\uF8FF]")
        private val PERIOD_YEAR_REGEX = Regex("""((?:19|20)\d{2})년""")
        private val TITLE_YEAR_REGEX = Regex("""\s*\((?:19|20)\d{2}\)\s*$""")
        private val URL_PLAYER_REGEX = Regex("""^https?://gogotv\d+\.xyz/player/([A-Za-z0-9]+)""")
        private val RULE_SIZES = intArrayOf(CATEGORIES.size, SORTS.size, COUNTRIES.size)
    }
}
