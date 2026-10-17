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
import eu.kanade.tachiyomi.network.POST
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
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
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 애니24 (ohli24.net).
 * 목록: /index.php?s=api&c=api&m=template&format=jsonp&name={ong|list|movie}.html&catid={3|1|2}&order=&weeks=&keyword=&page=
 *   (방영중·완결·극장판, 응답은 callback({"msg":"목록 HTML"}))
 * 검색: /search/keyword-{검색어}[-parent_id-0-page-N].html, 작품: /{번호}/{제목}.html (회차 .eps-box, 날짜 .eps-date),
 * 회차: /{번호}/{제목}-N화.html 안의 iframe#video(michealcdn.com/video/…) 플레이어
 */
class Ohli24 : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "애니24"
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
        .addInterceptor(PageCache(Regex("^/\\d+/")))
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
        .addInterceptor(RetryOnce(HOST_REGEX))
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", USER_AGENT)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 목록 =================
    private fun listUrl(idx: IntArray, page: Int): String {
        val (tpl, catid) = KINDS[idx[0]].second
        val b = "$baseUrl/index.php".toHttpUrl().newBuilder()
            .addQueryParameter("s", "api")
            .addQueryParameter("c", "api")
            .addQueryParameter("m", "template")
            .addQueryParameter("format", "jsonp")
            .addQueryParameter("name", "$tpl.html")
            .addQueryParameter("catid", catid)
            .addQueryParameter("order", SORTS[idx[3]].second)
        if (idx[0] == 0 && idx[1] > 0) b.addQueryParameter("weeks", idx[1].toString())
        if (idx[2] > 0) b.addQueryParameter("keyword", GENRES[idx[2]])
        if (page > 1) b.addQueryParameter("page", page.toString())
        return b.build().toString()
    }

    private fun ruleSizes() = intArrayOf(KINDS.size, DAYS.size, GENRES.size, SORTS.size)

    // 기본: 인기 = 방영중 인기순, 최신 = 방영중 업데이트순 (필터의 "인기/최신 탭 규칙"으로 바꿀 수 있음)
    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        // 작품 주소를 붙여 넣으면 그 작품을 바로 열기
        PASTE_REGEX.find(q)?.let { m -> return GET(baseUrl + m.groupValues[1], h()) }
        if (q.isNotEmpty()) {
            val enc = URLEncoder.encode(q, "UTF-8")
            val path = if (page > 1) "/search/keyword-$enc-parent_id-0-page-$page.html" else "/search/keyword-$enc.html"
            return GET(baseUrl + path, h())
        }
        fun sel(f: AnimeFilter.Select<*>?, def: Int) = f?.state ?: def
        val idx = intArrayOf(
            sel(filters.filterIsInstance<KindFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<DayFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<GenreFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<SortFilter>().firstOrNull(), 0),
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val path = response.request.url.encodedPath
        if (DETAIL_PATH.containsMatchIn(path) && !path.contains("/search/")) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { url = response.request.url.encodedPath.let(::decodePath) }), false)
        }
        return parseList(response)
    }

    /** 목록 API(callback({"msg": HTML}))나 검색 페이지에서 작품 카드(div.show-item)를 읽음 */
    private fun parseList(response: Response): AnimesPage {
        val text = response.body.string()
        val reqUrl = response.request.url
        val html = if (reqUrl.encodedPath.startsWith("/index.php")) {
            val start = text.indexOf('{')
            val end = text.lastIndexOf('}')
            if (start < 0 || end <= start) throw Exception("애니24 목록을 읽지 못했습니다")
            JSONObject(text.substring(start, end + 1)).optString("msg")
        } else {
            text
        }
        val kind = if (reqUrl.encodedPath.startsWith("/index.php")) reqUrl.queryParameter("catid") else null
        val doc = Jsoup.parse(html, "$baseUrl/")
        val seen = HashSet<String>()
        val animes = doc.select("div.show-item").mapNotNull { item ->
            val a = item.selectFirst("a.show-item-img-link, .show-item-tile-link a") ?: return@mapNotNull null
            val path = pathOf(a.attr("abs:href")) ?: return@mapNotNull null
            if (!seen.add(path)) return@mapNotNull null
            val year = YEAR_REGEX.find(item.selectFirst(".show-item-original-title")?.text().orEmpty())?.value
            val ended = kind == "1" || kind == "2"
            SAnime.create().apply {
                url = path
                val t = cardTitle(item, path)
                title = if (ended && year != null && !t.contains("($year)")) "$t ($year)" else t
                thumbnail_url = item.selectFirst("img")?.attr("abs:src")?.ifEmpty { null }
                status = when (kind) {
                    "3" -> SAnime.ONGOING
                    "1", "2" -> SAnime.COMPLETED
                    else -> SAnime.UNKNOWN
                }
            }
        }
        val hasNext = doc.selectFirst("li.next a[href], a.next[href]") != null
        return AnimesPage(animes, hasNext)
    }

    /** 카드 제목: 그림 title → 제목 칸. "…"로 잘렸으면 주소의 제목 부분을 씀 */
    private fun cardTitle(item: Element, path: String): String {
        val t = item.selectFirst("img[title]")?.attr("title")?.trim().orEmpty()
            .ifEmpty { item.selectFirst(".show-item-title")?.text()?.trim().orEmpty() }
        return if (t.isEmpty() || t.endsWith("...") || t.endsWith("…")) slugTitle(path).ifEmpty { t } else t
    }

    private fun slugTitle(path: String): String =
        path.substringAfterLast('/').removeSuffix(".html").replace('-', ' ').trim()

    private fun decodePath(p: String): String = runCatching { URLDecoder.decode(p.replace("+", "%2B"), "UTF-8") }.getOrDefault(p)

    /** "https://www.ohli24.net/58723/제목.html" → "/58723/제목.html" */
    private fun pathOf(href: String): String? {
        val u = href.toHttpUrlOrNull() ?: return null
        if (!HOST_REGEX.matches(u.host)) return null
        val p = decodePath(u.encodedPath)
        return if (DETAIL_PATH.containsMatchIn(p)) p else null
    }

    // ================= 작품 정보 =================
    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url

    private fun meta(doc: Document): Map<String, String> = doc.select(".article-box-meta li").associate { li ->
        val spans = li.select("span")
        spans.firstOrNull()?.text()?.trim()?.removeSuffix(":").orEmpty() to spans.drop(1).joinToString("") { it.text() }.trim()
    }

    private fun kindOf(doc: Document): String =
        doc.select("ul.breadcrumb li a").map { it.attr("href") }.firstNotNullOfOrNull { href ->
            when {
                href.endsWith("/finished") -> "완결"
                href.endsWith("/movie") -> "극장판"
                href.endsWith("/ing") -> "방영중"
                else -> null
            }
        }.orEmpty()

    override fun animeDetailsParse(response: Response): SAnime {
        val doc = Jsoup.parse(response.body.string(), response.request.url.toString())
        val m = meta(doc)
        val kind = kindOf(doc)
        val eps = episodesOf(doc)
        val latest = eps.mapNotNull { it.date }.maxOrNull()
        val year = YEAR_REGEX.find(m["방영일"].orEmpty())?.value
        return SAnime.create().apply {
            val t = doc.selectFirst("header.top-movies-list-title h2")?.text()?.trim().orEmpty()
            title = if (kind != "방영중" && kind.isNotEmpty() && year != null && !t.contains("($year)")) "$t ($year)" else t
            thumbnail_url = doc.selectFirst(".article-box-img img")?.attr("abs:src")?.ifEmpty { null }
            genre = m["장르"]?.split(',', '/', '·')?.map { it.trim() }?.filter { it.isNotEmpty() }?.joinToString(", ")?.ifEmpty { null }
            author = m["원작"]?.ifEmpty { null }
            artist = m["감독"]?.ifEmpty { null }
            status = when (kind) {
                "방영중" -> SAnime.ONGOING
                "완결", "극장판" -> SAnime.COMPLETED
                else -> SAnime.UNKNOWN
            }
            if (kind == "극장판") update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            val story = doc.selectFirst(".movie-coment p")?.let { p ->
                p.select("br").append("\\n")
                p.text().replace("\\n", "\n").lines().joinToString("\n") { it.trim() }.replace(Regex("\n{3,}"), "\n\n").trim()
            }
            val info = listOf("원제", "원작", "감독", "각본", "방영일", "등급", "총화수")
                .mapNotNull { k -> m[k]?.ifEmpty { null }?.let { "$k: $it" } }
                .joinToString("\n")
            description = listOfNotNull(
                if (kind == "방영중" && latest != null) "방영 중 · 최근 방영: ${synchronized(OUT_FMT) { OUT_FMT.format(latest) }}" else null,
                story?.ifEmpty { null },
                (listOfNotNull(kind.ifEmpty { null }).joinToString() + if (info.isNotEmpty()) "\n$info" else "").trim().ifEmpty { null },
            ).joinToString("\n\n")
        }
    }

    // ================= 회차 =================
    private class Ep(val path: String, val label: String, val number: Float?, val date: java.util.Date?)

    private fun episodesOf(doc: Document): List<Ep> = doc.select(".eps-box .eps-item a[href]").mapNotNull { a ->
        val path = a.attr("abs:href").toHttpUrlOrNull()?.encodedPath?.let(::decodePath) ?: return@mapNotNull null
        val dateText = a.selectFirst(".eps-date")?.text()?.trim().orEmpty()
        val label = a.ownText().trim().ifEmpty { a.text().replace(dateText, "").trim() }
        val date = DATE_REGEX.find(dateText)?.value?.let { d -> runCatching { synchronized(IN_FMT) { IN_FMT.parse(d) } }.getOrNull() }
        Ep(path, label, EP_NUM_REGEX.find(label)?.groupValues?.get(1)?.toFloatOrNull(), date)
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = Jsoup.parse(response.body.string(), response.request.url.toString())
        val eps = episodesOf(doc)
        val used = HashSet<Float>()
        // 사이트는 최신 회차가 위 → 아래에서부터 차례 번호를 매김
        return eps.reversed().mapIndexed { i, ep ->
            var n = ep.number ?: (i + 1).toFloat()
            while (!used.add(n)) n += 0.01f
            SEpisode.create().apply {
                url = ep.path
                name = ep.label.ifEmpty { "${i + 1}화" } + (ep.date?.let { d -> " (${synchronized(SHORT_FMT) { SHORT_FMT.format(d) }})" } ?: "")
                episode_number = n
                date_upload = ep.date?.time ?: 0L
            }
        }.reversed()
    }

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val pageUrl = baseUrl + episode.url
        // [임시 측정] 단계별 걸린 시간 (화질 이름 뒤에 표시, 원인 찾으면 뺄 것)
        val t0 = System.currentTimeMillis()
        val times = mutableListOf<String>()
        fun lap(name: String, since: Long) = times.add("$name ${"%.1f".format((System.currentTimeMillis() - since) / 1000.0)}")
        val doc = client.newCall(GET(pageUrl, h())).execute().use { res ->
            if (!res.isSuccessful) throw Exception("회차 화면을 열지 못했습니다 (HTTP ${res.code})")
            Jsoup.parse(res.body.string(), res.request.url.toString())
        }
        val players = doc.select("iframe#video[src], .play-box iframe[src]").map { it.attr("abs:src") }
            .filter { it.startsWith("http") }.distinct()
        if (players.isEmpty()) throw Exception("이 회차에는 재생 화면이 없습니다")
        lap("회차화면", t0)
        val errors = mutableListOf<String>()
        val out = mutableListOf<Video>()
        players.forEachIndexed { i, player ->
            val label = if (i == 0) LABEL else "$LABEL (대체 $i)"
            val t1 = System.currentTimeMillis()
            val fired = runCatching { firePlayer(player, pageUrl) }.getOrNull()
            lap("플레이어$i", t1)
            val t2 = System.currentTimeMillis()
            val found = fired ?: sniffWithWebView(player, pageUrl)?.also { lap("웹뷰$i", t2) }
            if (found == null) {
                errors.add(player.toHttpUrlOrNull()?.host ?: player)
                return@forEachIndexed
            }
            val vh = videoHeaders(found.second)
            val t3 = System.currentTimeMillis()
            out += HlsQuality.expand(client, found.first, label, vh)
            lap("화질$i", t3)
        }
        lap("합계", t0)
        val tag = " [${times.joinToString("·")}초]"
        if (out.isEmpty()) throw Exception("영상 주소를 찾지 못했습니다 [${errors.joinToString()}]")
        HlsQuality.sort(prefs(), out.map { Video(it.url, it.quality + tag, it.videoUrl, it.headers) })
    }

    /**
     * 플레이어(michealcdn 등)가 스스로 부르는 영상 주소 요청을 그대로 함:
     * POST {플레이어}/player/index.php?data={영상ID}&do=getVideo (hash={영상ID}, r={회차 화면}) → JSON 안의 m3u8
     */
    private fun firePlayer(player: String, pageUrl: String): Pair<String, String>? {
        val u = player.toHttpUrlOrNull() ?: return null
        val vid = u.pathSegments.lastOrNull { it.isNotEmpty() } ?: return null
        val origin = "${u.scheme}://${u.host}"
        // 다른 애니24 확장앱(DC 애니24)과 같은 요청: Referer·Origin 은 플레이어 주소 앞부분, r 은 빈 값
        val body = FormBody.Builder().add("hash", vid).add("r", "").build()
        val headers = Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", origin)
            .set("Origin", origin)
            .set("X-Requested-With", "XMLHttpRequest")
            .build()
        return client.newCall(POST("$origin/player/index.php?data=$vid&do=getVideo", headers, body)).execute().use { res ->
            if (!res.isSuccessful) return null
            val text = res.body.string()
            // securedLink = 영상 전체 재생 목록 (videoSource 의 /m3/… 는 앞부분 몇 초짜리)
            val secured = runCatching { JSONObject(text).optString("securedLink") }.getOrNull()
                ?.takeIf { it.startsWith("http") }
            val media = secured ?: M3U8_REGEX.find(text.replace("\\/", "/"))?.value ?: return null
            media to player
        }
    }

    private fun videoHeaders(referer: String): Headers {
        val origin = referer.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" }
        return Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", origin?.let { "$it/" } ?: referer)
            .set("X-Requested-With", "XMLHttpRequest")
            .set("Accept", "*/*")
            .apply { if (origin != null) set("Origin", origin) }
            .build()
    }

    /** 숨은 WebView 로 플레이어를 열고, 처음 나오는 m3u8 요청 주소와 그 Referer 를 돌려줌 */
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
                        if (found == null && (path.endsWith(".m3u8") || path.endsWith(".mp4"))) {
                            found = request.url.toString() to (request.requestHeaders["Referer"] ?: lastPage)
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

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList {
        fun text(i: IntArray) = listOfNotNull(
            KINDS[i[0]].first,
            DAYS[i[1]].takeIf { i[0] == 0 && i[1] > 0 },
            GENRES[i[2]].takeIf { i[2] > 0 },
            SORTS[i[3]].first,
        ).joinToString(" · ")
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}"),
                AnimeFilter.Separator(),
                AnimeFilter.Header("검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)"),
                KindFilter(),
                DayFilter(),
                GenreFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class KindFilter : AnimeFilter.Select<String>("분류", KINDS.map { it.first }.toTypedArray())
    class DayFilter : AnimeFilter.Select<String>("요일 (방영중만)", DAYS.toTypedArray())
    class GenreFilter : AnimeFilter.Select<String>("장르", GENRES.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "애니24 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다. 사이트가 새 주소로 넘겨 주면 자동으로 저장됩니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 애니24 주소 (예: https://www.ohli24.net)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://www.ohli24.net)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val DEFAULT_BASE_URL = "https://www.ohli24.net"
        private const val RATE_GAP_MS = 300L
        private const val LABEL = "애니24"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?ohli\d*24\.[a-z]{2,6}$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?ohli\d*24\.[a-z]{2,6}$""")
        private val PASTE_REGEX = Regex("""ohli\d*24\.[a-z]{2,6}(/\d+/[^?#\s]+\.html)""")
        private val DETAIL_PATH = Regex("""^/\d+/[^/]+\.html$""")
        private val YEAR_REGEX = Regex("""(?:19|20)\d{2}""")
        private val DATE_REGEX = Regex("""\d{4}-\d{2}-\d{2}""")
        private val EP_NUM_REGEX = Regex("""(\d+(?:\.\d+)?)\s*화""")
        private val M3U8_REGEX = Regex("""https?://[^"'\s<>]+\.m3u8[^"'\s<>]*""")

        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val IN_FMT = SimpleDateFormat("yyyy-MM-dd", Locale.KOREA).apply { timeZone = KST }
        private val OUT_FMT = SimpleDateFormat("yyyy.MM.dd (E)", Locale.KOREA).apply { timeZone = KST }
        private val SHORT_FMT = SimpleDateFormat("MM.dd", Locale.KOREA).apply { timeZone = KST }

        /** 분류 → (목록 틀 이름, catid) */
        private val KINDS = listOf("방영중" to ("ong" to "3"), "완결" to ("list" to "1"), "극장판" to ("movie" to "2"))

        /** 요일 (사이트 값 1=일요일 … 7=토요일, 8=기타) */
        private val DAYS = listOf("전체", "일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "기타")

        /** 장르 (사이트 목록의 장르 선택) */
        private val GENRES = listOf(
            "전체", "미스테리", "추리", "거대로봇", "SF", "모험", "백합", "판타지", "이세계", "코미디", "하렘", "학원",
            "로맨스", "액션", "닌자", "아이돌", "게임", "스포츠", "청춘", "능력", "드라마", "성장", "일상", "연애", "배틀",
        )

        /** 정렬 (사이트 표시 그대로: 업데이트=updatetime, 인기순=air_date, 방영일=hits) */
        private val SORTS = listOf("업데이트" to "updatetime", "인기순" to "air_date", "방영일" to "hits")

        private val DEFAULT_POPULAR = intArrayOf(0, 0, 0, 1)
        private val DEFAULT_LATEST = intArrayOf(0, 0, 0, 0)

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "magsrv.com",
            "runative-syndicate.com",
        )
    }
}
