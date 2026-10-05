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
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.io.ByteArrayInputStream
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 티비착 (tvchak숫자.com) - MacCMS 사이트.
 * 재생 페이지의 `var player_aaaa={...}` 안에 영상 주소(mp4/m3u8)가 그대로 들어 있다.
 * 사이트가 해외 접속을 막아서 저장소 감시는 못 하고, 주소 자동 찾기는 폰에서 동작한다.
 */
class TVchak : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "티비착"
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

    override val client: OkHttpClient = network.client.newBuilder()
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS))
        .addInterceptor { chain -> domainIntercept(chain) }
        .addInterceptor { chain -> challengeIntercept(chain) }
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", USER_AGENT)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 도메인 자동 찾기 =================
    private fun isDead(res: Response): Boolean {
        if (!HOST_REGEX.matches(res.request.url.host)) return true
        return res.code == 451 || res.code >= 500
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

        val finalHost = res.request.url.host
        if (finalHost != baseHost && HOST_REGEX.matches(finalHost)) saveDomain("https://$finalHost")
        return res
    }

    // ================= 보안 확인 페이지 자동 통과 =================
    // 사이트(CloudFront)가 일정 시간마다 실제 페이지 대신 보안 확인 페이지를 보낸다.
    // 그럴 때 숨은 WebView 로 같은 주소를 열어 확인을 끝내고(통과 쿠키 저장) 같은 요청을 다시 보낸다.
    private fun isSitePage(req: Request): Boolean {
        val path = req.url.encodedPath
        return req.method == "GET" && HOST_REGEX.matches(req.url.host) &&
            (path == "/" || path.startsWith("/index.php"))
    }

    private fun isChallenge(res: Response): Boolean {
        if (res.header("x-amzn-waf-action") != null) return true
        if (res.code == 202 || res.code == 405) return true
        if (res.code !in 200..299) return false
        val body = res.peekBody(2_000_000).string()
        return !body.contains(PAGE_MARKER)
    }

    private fun challengeIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val res = chain.proceed(req)
        if (!isSitePage(req) || !isChallenge(res)) return res
        res.close()
        passChallenge(req.url.toString())
        val again = chain.proceed(req)
        if (isChallenge(again)) {
            again.close()
            throw Exception("사이트 보안 확인을 자동으로 통과하지 못했습니다. 오른쪽 위 메뉴의 WebView로 한 번 열었다 닫아 주세요.")
        }
        return again
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun passChallenge(url: String) = synchronized(CHALLENGE_LOCK) {
        val latch = CountDownLatch(1)
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
                webView.settings.userAgentString = USER_AGENT
                android.webkit.CookieManager.getInstance().setAcceptCookie(true)
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, pageUrl: String) {
                        // 확인이 끝나면 실제 페이지(maccms)가 다시 열린다
                        view.evaluateJavascript("document.documentElement.outerHTML.indexOf('$PAGE_MARKER') >= 0") {
                            if (it == "true") latch.countDown()
                        }
                    }
                }
                webView.loadUrl(url, mapOf("Referer" to "$baseUrl/"))
            } catch (e: Exception) {
                latch.countDown()
            }
        }
        latch.await(25, TimeUnit.SECONDS)
        handler.post {
            android.webkit.CookieManager.getInstance().flush()
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }
        Thread.sleep(300)
    }

    @Volatile private var lastDiscover = 0L

    private fun hostNumber(host: String): Int =
        NUMBER_REGEX.find(host)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    // tvchak 번호 주소를 현재 번호 -5 ~ +30 범위에서 동시에 열어 보고, 실제 티비착인 가장 큰 번호를 고른다
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
                .map { "tvchak$it.com" }
                .map { host ->
                    pool.submit<String?> {
                        try {
                            val r = Request.Builder().url("https://$host/").header("User-Agent", USER_AGENT).build()
                            plain.newCall(r).execute().use { res ->
                                val fh = res.request.url.host
                                val ok = HOST_REGEX.matches(fh) && res.code == 200 &&
                                    res.peekBody(300_000).string().contains(SITE_MARKER)
                                if (ok) fh else null
                            }
                        } catch (e: Exception) {
                            null
                        }
                    }
                }
            futures.mapNotNull { it.get() }.maxByOrNull { hostNumber(it) }?.takeIf { it != currentHost }
        } finally {
            pool.shutdown()
        }
    }

    // ================= 목록 =================
    private fun showUrl(typeId: String, sort: String, page: Int): String {
        val sb = StringBuilder("$baseUrl/index.php/vod/show")
        if (typeId.isNotEmpty()) sb.append("/id/").append(typeId)
        sb.append("/by/").append(sort)
        if (page > 1) sb.append("/page/").append(page)
        return sb.append(".html").toString()
    }

    // 인기/최신 탭: 필터에서 저장한 조건이 있으면 그 조건으로, 없으면 기본 목록
    override fun popularAnimeRequest(page: Int): Request =
        TabRule.read(prefs(), true, RULE_SIZES)?.let { filterRequest(page, it) } ?: defaultPopular(page)

    private fun defaultPopular(page: Int): Request =
        GET("$baseUrl/index.php/vod/show2/by/hits/id/100" + (if (page > 1) "/page/$page" else "") + ".html", h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response.asDoc())

    // 분류 없는 최신 목록 주소는 사이트에서 열리지 않아, 첫 화면(오늘의 핫업데이트 + 분류별 최신)을 쓴다
    override fun latestUpdatesRequest(page: Int): Request =
        TabRule.read(prefs(), false, RULE_SIZES)?.let { filterRequest(page, it) } ?: defaultLatest()

    private fun defaultLatest(): Request = GET("$baseUrl/", h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        // 사이트 작품 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
        URL_ID_REGEX.find(query.trim())?.let { m ->
            return GET("$baseUrl/index.php/vod/detail/id/${m.groupValues[1]}.html", h())
        }
        if (query.isNotBlank()) {
            val q = URLEncoder.encode(query.trim(), "UTF-8").replace("+", "%20")
            val url = if (page > 1) {
                "$baseUrl/index.php/vod/search/page/$page/wd/$q.html"
            } else {
                "$baseUrl/index.php/vod/search.html?wd=$q"
            }
            return GET(url, h())
        }
        val idx = IntArray(RULE_SIZES.size)
        var rule = 0
        filters.forEach { f ->
            when (f) {
                is TypeFilter -> idx[0] = f.state
                is SortFilter -> idx[1] = f.state
                is TabRule.RuleFilter -> rule = f.state
                else -> {}
            }
        }
        TabRule.apply(prefs(), rule, idx)
        return filterRequest(page, idx)
    }

    /** idx = [분류, 정렬] 선택 번호 */
    private fun filterRequest(page: Int, idx: IntArray): Request {
        val type = TYPES[idx[0]].second
        val sort = SORTS[idx[1]].second
        if (type.isEmpty()) {
            return if (sort == "hits") defaultPopular(page) else defaultLatest()
        }
        return GET(showUrl(type, sort, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val doc = response.asDoc()
        val path = response.request.url.encodedPath
        if (!path.contains("/vod/detail/")) return parseList(doc)
        // 주소로 찾은 작품 하나
        val name = doc.selectFirst("h1.movie-title")?.text()?.trim().orEmpty()
        if (name.isEmpty()) return AnimesPage(emptyList(), false)
        return AnimesPage(
            listOf(
                SAnime.create().apply {
                    url = "/index.php" + path.substringAfter("/index.php")
                    title = name
                    thumbnail_url = doc.selectFirst(".poster img")?.absUrl("src")?.ifEmpty { null }
                },
            ),
            false,
        )
    }

    /** 본문(.mobile-main) 안의 작품 카드만 모음 - 옆 추천 목록은 제외 */
    private fun parseList(doc: Document): AnimesPage {
        // 영화 분류(1) 목록이면 연도를 읽어 옴
        val movieList = MOVIE_LIST_REGEX.containsMatchIn(doc.location())
        val main = doc.selectFirst(".mobile-main") ?: doc
        val seen = HashSet<String>()
        val animes = main.select(".movie-list-item, .vod-search-list").mapNotNull { box ->
            val a = box.selectFirst("a[href*=/vod/detail/id/]") ?: return@mapNotNull null
            val path = pathOf(a.attr("href"))
            if (!seen.add(path)) return@mapNotNull null
            val t = box.selectFirst(".movie-title")
            SAnime.create().apply {
                url = path
                title = (t?.attr("title")?.ifEmpty { null } ?: t?.text()).orEmpty().trim()
                thumbnail_url = thumbOf(box)
            }
        }.filter { it.title.isNotEmpty() }
        addYears(animes, movieList)
        return AnimesPage(animes, hasNextPage(doc))
    }

    /**
     * 목록 카드 제목 뒤에 정보를 붙임: 영화와 방영이 끝난 드라마·예능은 연도 "(2024)",
     * 방영 중인 드라마·예능은 최근 방영일 " · 10.04".
     * 목록 페이지에는 둘 다 없어서 각 작품 상세 페이지에서 읽어 폰에 저장해 둔다.
     * 영화 연도는 한 번만 읽고, 방영 중인 시리즈는 6시간, 끝난 시리즈는 7일이 지나면 다시 읽는다.
     */
    private fun addYears(animes: List<SAnime>, movieList: Boolean) {
        val p = prefs()
        fun idOf(a: SAnime) = ID_REGEX.find(a.url)?.groupValues?.get(1)
        val now = System.currentTimeMillis()
        // 한꺼번에 많이 읽으면 사이트(CloudFront)가 접속을 잠시 차단하므로
        // 한 번에 하나씩, 간격을 두고, 목록 한 번에 최대 8개만 읽는다. 막히는 기미가 보이면 10분 쉼
        if (p != null && now > p.getLong("year_pause_until", 0L)) {
            val ids = animes.mapNotNull { idOf(it) }
            // 처음 보는 작품 먼저, 그다음 방영일이 오래된 시리즈 (영화 목록에서는 시리즈를 다시 읽지 않음)
            val unknown = ids.filter { !p.contains("year_$it") }
            val stale = if (movieList) {
                emptyList()
            } else {
                ids.filter { id ->
                    val (latest, checked) = airOf(p, id)
                    val ttl = if (now - latest <= ONGOING_DAYS * 86_400_000L) AIR_TTL_MS else ENDED_TTL_MS
                    p.getString("year_$id", null) == "-" && now - checked > ttl
                }
            }
            for (id in (unknown + stale).take(8)) {
                val ok = runCatching {
                    client.newCall(GET("$baseUrl/index.php/vod/detail/id/$id.html", h())).execute().use { res ->
                        val html = res.body.string()
                        if (res.code != 200 || !html.contains(PAGE_MARKER)) return@use false
                        saveInfo(id, Jsoup.parse(html))
                        true
                    }
                }.getOrDefault(false)
                if (!ok) {
                    p.edit().putLong("year_pause_until", System.currentTimeMillis() + 10 * 60_000L).apply()
                    break
                }
                Thread.sleep(700)
            }
        }
        val md = java.text.SimpleDateFormat("MM.dd", java.util.Locale.KOREAN)
            .apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }
        val yf = java.text.SimpleDateFormat("yyyy", java.util.Locale.KOREAN)
            .apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }
        fun withYear(a: SAnime, y: String) {
            if (!a.title.contains(y)) a.title = "${a.title} ($y)"
        }
        animes.forEach { a ->
            val id = idOf(a) ?: return@forEach
            val y = p?.getString("year_$id", null) ?: return@forEach
            if (YEAR_REGEX.matches(y)) return@forEach withYear(a, y)
            val latest = airOf(p, id).first
            if (latest <= 0) return@forEach
            if (now - latest <= ONGOING_DAYS * 86_400_000L) {
                a.title = "${a.title} · ${md.format(java.util.Date(latest))}"
            } else {
                // 방영이 끝난 시리즈: 사이트의 연도, 없으면 마지막 방영 연도
                withYear(a, seriesYear(p, id) ?: yf.format(java.util.Date(latest)))
            }
        }
    }

    /** 저장된 시리즈 연도 (사이트 표기) */
    private fun seriesYear(p: SharedPreferences, id: String): String? =
        p.getString("air_$id", null)?.split("|")?.getOrNull(2)?.takeIf { YEAR_REGEX.matches(it) }

    /** 저장된 최근 방영일 (방영일, 읽은 시각). 없으면 (0, 0) */
    private fun airOf(p: SharedPreferences, id: String): Pair<Long, Long> {
        val v = p.getString("air_$id", null)?.split("|") ?: return 0L to 0L
        return (v.getOrNull(0)?.toLongOrNull() ?: 0L) to (v.getOrNull(1)?.toLongOrNull() ?: 0L)
    }

    /** 상세 페이지에서 영화 연도 또는 시리즈 최근 방영일을 읽어 저장 (목록 카드용) */
    private fun saveInfo(id: String, doc: Document) {
        val p = prefs() ?: return
        val labels = doc.select("#tagContent a[href*=/vod/play/], .content_playlist a[href*=/vod/play/]")
            .ifEmpty { doc.select("a[href*=/vod/play/]") }
            .distinctBy { it.attr("href") }.map { it.text().trim() }
        val e = p.edit()
        val y = doc.selectFirst(".scroll-content a[href*=/year/]")?.text()?.trim().orEmpty()
        if (labels.size <= 1) {
            e.putString("year_$id", if (YEAR_REGEX.matches(y)) y else "-")
        } else {
            // 시리즈는 "-" 로 표시하고, 최근 방영일·읽은 시각·연도는 따로 저장
            val latest = labels.map { dateOf(it) }.filter { it > 0 }.maxOrNull() ?: 0L
            e.putString("year_$id", "-").putString("air_$id", "$latest|${System.currentTimeMillis()}|$y")
        }
        e.apply()
    }

    private fun thumbOf(box: Element): String? {
        val lazy = box.selectFirst(".movie-post-lazyload") ?: return box.selectFirst("img")?.absUrl("src")
        lazy.attr("data-original").takeIf { it.startsWith("http") }?.let { return it }
        return BG_REGEX.find(lazy.attr("style"))?.groupValues?.get(1)?.takeIf { it.startsWith("http") }
    }

    private fun hasNextPage(doc: Document): Boolean {
        val cur = doc.selectFirst("#page .page-current")?.text()?.trim()?.toIntOrNull() ?: return false
        val max = doc.select("#page a[href]").mapNotNull {
            PAGE_REGEX.find(it.attr("href"))?.groupValues?.get(1)?.toIntOrNull()
        }.maxOrNull() ?: return false
        return max > cur
    }

    // ================= 상세 =================
    override fun animeDetailsParse(response: Response): SAnime {
        val doc = response.asDoc()
        val name = doc.selectFirst("h1.movie-title")?.text()?.trim().orEmpty()
        val labels = doc.select("#tagContent a[href*=/vod/play/], .content_playlist a[href*=/vod/play/]")
            .distinctBy { it.attr("href") }.map { it.text().trim() }
        val plot = doc.selectFirst("#sum_tag")?.text()?.trim().orEmpty()
        // 목록 카드에도 같은 연도/방영일이 붙도록 저장
        ID_REGEX.find(response.request.url.encodedPath)?.groupValues?.get(1)?.let { saveInfo(it, doc) }
        return SAnime.create().apply {
            thumbnail_url = doc.selectFirst(".poster img")?.absUrl("src")?.ifEmpty { null }
            genre = doc.select(".scroll-content a").map { it.text().trim() }.filter { it.isNotEmpty() }
                .joinToString(", ").ifEmpty { null }
            author = doc.select("p.starLink a").joinToString(", ") { it.text().trim() }.ifEmpty { null }

            if (labels.size <= 1) {
                // 영화(회차 1개): 제목 옆에 개봉 연도
                val year = doc.selectFirst(".scroll-content a[href*=/year/]")?.text()?.trim()
                    ?.takeIf { YEAR_REGEX.matches(it) }
                title = if (year != null && !name.contains(year)) "$name ($year)" else name
                status = SAnime.COMPLETED
                description = plot
            } else {
                // 드라마·예능: 가장 최근 방영일로 방영 중/종영 판단 (목록 카드와 같은 기준).
                // 제목도 목록 카드와 똑같이 (애니요미는 한 번 연 작품을 목록에서 이 제목으로 보여 줌):
                // 방영 중 "제목 · 10.04", 끝났으면 "제목 (2019)"
                val year = doc.selectFirst(".scroll-content a[href*=/year/]")?.text()?.trim()
                    ?.takeIf { YEAR_REGEX.matches(it) }
                val latest = labels.map { dateOf(it) }.filter { it > 0 }.maxOrNull()
                status = when {
                    latest == null -> SAnime.UNKNOWN
                    System.currentTimeMillis() - latest <= ONGOING_DAYS * 86_400_000L -> SAnime.ONGOING
                    else -> SAnime.COMPLETED
                }
                val endYear = year ?: latest?.let {
                    java.text.SimpleDateFormat("yyyy", java.util.Locale.KOREAN)
                        .apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(java.util.Date(it))
                }
                val md = latest?.let {
                    java.text.SimpleDateFormat("MM.dd", java.util.Locale.KOREAN)
                        .apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(java.util.Date(it))
                }
                title = when {
                    status == SAnime.ONGOING && md != null -> "$name · $md"
                    endYear != null && !name.contains(endYear) -> "$name ($endYear)"
                    else -> name
                }
                val head = if (latest != null) {
                    val fmt = java.text.SimpleDateFormat("yyyy.MM.dd (E)", java.util.Locale.KOREAN)
                        .apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }
                    val st = if (status == SAnime.ONGOING) "방영 중" else "종영"
                    "$st · 최근 방영: ${fmt.format(java.util.Date(latest))} · 총 ${labels.size}회"
                } else {
                    "총 ${labels.size}회"
                }
                description = listOf(head, plot).filter { it.isNotEmpty() }.joinToString("\n\n")
            }
        }
    }

    // ================= 회차 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val boxes = doc.select("#tagContent .play_list_box").ifEmpty { doc.select(".content_playlist") }
        val tabs = doc.select("#tag .swiper-slide, #tag a").map { it.text().trim() }
        val out = ArrayList<SEpisode>()
        val seen = HashSet<String>()
        boxes.forEachIndexed { bi, box ->
            val links = box.select("a[href*=/vod/play/]")
            // 서버가 여러 개면 서버 이름을 "스캔레이터"로 넣어 앱에서 서버별로 거를 수 있게 함
            val server = if (boxes.size > 1) tabs.getOrNull(bi)?.ifEmpty { null } ?: "서버 ${bi + 1}" else null
            links.forEachIndexed { i, a ->
                val path = pathOf(a.attr("href"))
                if (!seen.add(path)) return@forEachIndexed
                val label = a.text().trim().ifEmpty { "바로보기" }
                out.add(
                    SEpisode.create().apply {
                        url = path
                        name = label
                        scanlator = server
                        episode_number = EP_REGEX.find(label)?.groupValues?.get(1)?.toFloatOrNull()
                            ?: (links.size - i).toFloat()
                        date_upload = dateOf(label)
                    },
                )
            }
        }
        return out
    }

    /** "26/10/02" 같은 방송일 → 날짜 */
    private fun dateOf(label: String): Long {
        val m = DATE_REGEX.find(label) ?: return 0L
        return runCatching {
            Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul")).apply {
                clear()
                set(2000 + m.groupValues[1].toInt(), m.groupValues[2].toInt() - 1, m.groupValues[3].toInt())
            }.timeInMillis
        }.getOrDefault(0L)
    }

    // ================= 영상 =================
    override fun videoListRequest(episode: SEpisode): Request = GET(baseUrl + episode.url, h())

    override fun videoListParse(response: Response): List<Video> {
        val pageUrl = response.request.url.toString()
        val html = response.body.string()

        val media = PLAYER_REGEX.find(html)?.groupValues?.get(1)?.let { json ->
            runCatching {
                val o = JSONObject(json)
                decodeUrl(o.optString("url"), o.optInt("encrypt"))
            }.getOrNull()
        }?.takeIf { MEDIA_REGEX.containsMatchIn(it) }

        val videos = ArrayList<Video>()
        if (media != null) {
            // 사이트 플레이어(iframe) 안에서 재생되는 것과 같은 Referer 를 붙임. 안 되면 두 번째 항목으로
            videos.addAll(HlsQuality.expand(client, media, qualityOf(media), videoHeaders(PLAYER_REFERER)))
            videos.add(Video(media, qualityOf(media) + " (대체)", media, videoHeaders("$baseUrl/")))
            return HlsQuality.sort(prefs(), videos)
        }

        // 영상 주소가 바로 없으면 숨은 화면(WebView)으로 열어 영상 요청을 가로챈다
        val (sniffed, referer) = sniffWithWebView(pageUrl)
            ?: throw Exception("영상 주소를 찾지 못했습니다: $pageUrl")
        return HlsQuality.sort(prefs(), HlsQuality.expand(client, sniffed, qualityOf(sniffed), videoHeaders(referer)))
    }

    private fun decodeUrl(raw: String, encrypt: Int): String = when (encrypt) {
        1 -> URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8")
        2 -> URLDecoder.decode(
            String(android.util.Base64.decode(raw, android.util.Base64.DEFAULT)).replace("+", "%2B"),
            "UTF-8",
        )
        else -> raw
    }

    private fun qualityOf(url: String) = if (url.contains(".m3u8")) "티비착 (HLS)" else "티비착"

    private fun videoHeaders(referer: String): Headers {
        val origin = referer.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" }
        return Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", referer)
            .apply { if (origin != null) set("Origin", origin) }
            .build()
    }

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
        "tvchak",
        baseUrl,
        autoDomain(),
        AnimeFilterList(
            AnimeFilter.Header("검색어가 없을 때만 적용"),
            TypeFilter(),
            SortFilter(),
            *TabRule.filters(prefs(), RULE_SIZES, "전체 · 인기순" to "첫 화면 최신") {
                "${TYPES[it[0]].first} · ${SORTS[it[1]].first}"
            }.toTypedArray(),
        ),
    )

    class TypeFilter : AnimeFilter.Select<String>("분류", TYPES.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        fun summaryOf(current: String) = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다.\n현재 주소: $current"

        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "티비착 주소 직접 지정 (선택)"
            summary = summaryOf(baseUrl)
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "tvchak숫자.com 형식의 HTTPS 주소만 허용됩니다."
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
                        Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://tvchak209.com)", Toast.LENGTH_LONG).show()
                        false
                    }
                }
            }
        }.also(screen::addPreference)

        SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "접속이 안 되면 tvchak 번호 주소(현재 번호 -5 ~ +30)를 찾아 자동 변경합니다."
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
        private const val DEFAULT_BASE_URL = "https://tvchak208.com"
        private const val SITE_MARKER = "티비착"
        private const val PLAYER_REFERER = "https://ckp2.wiselife.blog/"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DISCOVER_LOCK = Any()
        private val CHALLENGE_LOCK = Any()
        private const val PAGE_MARKER = "maccms"

        private val DOMAIN_REGEX = Regex("""^https://tvchak\d+\.com$""")
        private val HOST_REGEX = Regex("""^tvchak\d+\.com$""")
        private val NUMBER_REGEX = Regex("""tvchak(\d+)\.com""")
        private val PATH_REGEX = Regex("""^https?://[^/]+(/.*)$""")
        private val PAGE_REGEX = Regex("""/page/(\d+)""")
        private val BG_REGEX = Regex("""url\(['"]?([^'")]+)""")
        private val EP_REGEX = Regex("""(\d+)\s*(?:화|회)""")
        private const val ONGOING_DAYS = 21
        private const val AIR_TTL_MS = 6 * 3_600_000L
        private const val ENDED_TTL_MS = 7 * 86_400_000L
        private const val RATE_GAP_MS = 350L
        private val URL_ID_REGEX = Regex("""^https?://tvchak\d+\.com(?:/.*?)?/vod/(?:detail|play)/id/(\d+)""")
        private val ID_REGEX = Regex("""/id/(\d+)""")
        private val MOVIE_LIST_REGEX = Regex("""/vod/(?:show|type)/id/1[/.]""")
        private val YEAR_REGEX = Regex("""^(?:19|20)\d{2}$""")
        private val DATE_REGEX = Regex("""^(\d{2})/(\d{2})/(\d{2})$""")
        private val PLAYER_REGEX = Regex("""var\s+player_\w+\s*=\s*(\{.*?\})\s*</script>""", RegexOption.DOT_MATCHES_ALL)
        private val MEDIA_REGEX = Regex(
            """https?://[^"'\s<>\\]+\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?""",
            RegexOption.IGNORE_CASE,
        )

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "cloudflareinsights.com",
        )

        private val TYPES = listOf(
            "전체" to "",
            "영화" to "1",
            "드라마" to "2",
            "드라마 - 월화" to "13",
            "드라마 - 수목" to "14",
            "드라마 - 금요/주말" to "15",
            "드라마 - 일일" to "21",
            "드라마 - 다시보기" to "22",
            "숏드" to "39",
            "예능" to "3",
            "예능 - 월요일" to "23",
            "예능 - 화요일" to "24",
            "예능 - 수요일" to "25",
            "예능 - 목요일" to "26",
            "예능 - 금요일" to "27",
            "예능 - 토요일" to "28",
            "예능 - 일요일" to "29",
            "애니" to "4",
        )
        private val SORTS = listOf("최신순" to "time", "인기순" to "hits")
        private val RULE_SIZES = intArrayOf(TYPES.size, SORTS.size)
    }
}
