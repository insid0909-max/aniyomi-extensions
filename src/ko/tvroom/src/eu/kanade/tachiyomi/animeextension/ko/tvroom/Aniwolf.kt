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
import rx.Observable
import java.io.ByteArrayInputStream
import java.net.URLDecoder
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 애니울프 (aniwolf.com, 2026-11-04, 망가요미 aniwolf.js 와 같은 구조).
 * 목록: /?menu=ing&day={u|1..6|0}&sort={new|hot}&page=N (방영중), /?menu=fin|film&sort=&page= (종영·극장판),
 *   /?menu=rank&period={now|day|week|month} (순위, 한 쪽), 검색 /?search=검색어&page=N. 카드 .animation-card a[title]
 * 작품: /{slug} (정보 table td, 회차 .bg-episode a + 날짜 "2026/11/02", 한 화면에 모든 회차), 회차: /{slug}/{N화}
 * 재생: 회차 화면의 mov.glamov.com/detail.php?v={ID} → 그 화면의 iframe(cdndania.com/video/{ID}) = 애니24와 같은 플레이어
 */
class Aniwolf : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "애니울프"
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
        .apply { interceptors().add(0, FriendlyNet) }
        .addInterceptor(PageCache(Regex("^/[^/?]+$")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS))
        .addInterceptor { chain ->
            // 사이트가 새 주소로 넘겨 주면 그 주소를 저장 (다음부터 바로 새 주소로)
            val res = chain.proceed(chain.request())
            val from = chain.request().url.host
            val to = res.request.url.host
            if (res.code == 200 && from != to && HOST_REGEX.matches(from) && HOST_REGEX.matches(to)) {
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
        val kind = KINDS[idx[0]].second
        val b = "$baseUrl/".toHttpUrl().newBuilder()
        if (kind == "rank") {
            return b.addQueryParameter("menu", "rank").addQueryParameter("period", PERIODS[idx[3]].second).build().toString()
        }
        b.addQueryParameter("menu", kind)
        if (kind == "ing") b.addQueryParameter("day", DAYS[idx[1]].second)
        b.addQueryParameter("sort", SORTS[idx[2]].second)
        if (page > 1) b.addQueryParameter("page", page.toString())
        return b.build().toString()
    }

    private fun ruleSizes() = intArrayOf(KINDS.size, DAYS.size, SORTS.size, PERIODS.size)

    // 기본: 인기 = 방영중 인기순, 최신 = 방영중 최신순 (필터의 "인기/최신 탭 규칙"으로 바꿀 수 있음)
    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    // 검색 띄어쓰기: 결과가 없으면 띄어쓰기 뺀 검색어 등으로 다시 찾음(SearchSpacing)
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> =
        SearchSpacing.wrap(page, query) { q, p -> super.fetchSearchAnime(p, q, filters) }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        PASTE_REGEX.find(q)?.let { m ->
            val work = decodePath(m.groupValues[1]).split('/').firstOrNull { it.isNotEmpty() }
            if (work != null && pathOf("$baseUrl/$work") != null) return GET("$baseUrl/$work", h())
        }
        if (q.isNotEmpty()) {
            val b = "$baseUrl/".toHttpUrl().newBuilder().addQueryParameter("search", q)
            if (page > 1) b.addQueryParameter("page", page.toString())
            return GET(b.build().toString(), h())
        }
        fun sel(f: AnimeFilter.Select<*>?, def: Int) = f?.state ?: def
        val idx = intArrayOf(
            sel(filters.filterIsInstance<KindFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<DayFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<SortFilter>().firstOrNull(), 0),
            sel(filters.filterIsInstance<PeriodFilter>().firstOrNull(), 0),
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val path = response.request.url.encodedPath
        if (path != "/" && path.isNotEmpty()) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { url = decodePath(path) }), false)
        }
        return parseList(response)
    }

    /** 목록 화면의 작품 카드 (.animation-card) */
    private fun parseList(response: Response): AnimesPage {
        val doc = Jsoup.parse(response.body.string(), response.request.url.toString())
        val page = response.request.url.queryParameter("page")?.toIntOrNull() ?: 1
        val seen = HashSet<String>()
        val animes = doc.select(".animation-card").mapNotNull { card ->
            val a = card.selectFirst("a[href]") ?: return@mapNotNull null
            val path = pathOf(a.attr("abs:href")) ?: return@mapNotNull null
            if (path.count { it == '/' } != 1 || !seen.add(path)) return@mapNotNull null
            val type = card.selectFirst(".animation-type")?.text()?.trim().orEmpty()
            val year = card.selectFirst(".animation-year")?.text()?.trim()?.takeIf { YEAR_ONLY.matches(it) }
            val t = a.attr("title").trim()
            SAnime.create().apply {
                url = path
                // 종영·극장판은 제목 뒤에 연도 (방영중 카드는 화수만 있어 날짜를 붙일 수 없음)
                title = if (year != null && type != "방영중" && !t.contains("($year)")) "$t ($year)" else t
                // 늦게 뜨는 그림(class=lazy)은 data-src 가 진짜 그림
                thumbnail_url = card.selectFirst("img")?.let { it.attr("abs:data-src").ifEmpty { it.attr("abs:src") } }?.ifEmpty { null }
                status = if (type == "방영중") SAnime.ONGOING else if (type.isNotEmpty()) SAnime.COMPLETED else SAnime.UNKNOWN
            }
        }
        val hasNext = doc.select("a[href]").any { Regex("""[?&]page=${page + 1}(?:&|$)""").containsMatchIn(it.attr("href")) }
        return AnimesPage(animes, hasNext)
    }

    private fun decodePath(p: String): String = runCatching { URLDecoder.decode(p.replace("+", "%2B"), "UTF-8") }.getOrDefault(p)

    /** "https://aniwolf.com/원피스/001화" → "/원피스/001화" (작품·회차 주소만, 메뉴 주소 제외) */
    private fun pathOf(href: String): String? {
        val u = href.toHttpUrlOrNull() ?: return null
        if (!HOST_REGEX.matches(u.host)) return null
        val p = decodePath(u.encodedPath)
        if (!WORK_PATH.matches(p) || RESERVED.containsMatchIn(p)) return null
        return p
    }

    // ================= 작품 정보 =================
    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + workOf(anime.url), h())

    override fun getAnimeUrl(anime: SAnime): String = baseUrl + workOf(anime.url)

    private fun workOf(path: String): String = "/" + path.trim('/').substringBefore('/')

    private fun meta(doc: Document): Map<String, String> = doc.select(".detail-description table tr").mapNotNull { tr ->
        val td = tr.select("td")
        if (td.size < 2) return@mapNotNull null
        val v = td[1].text().trim()
        if (v.isEmpty() || v == "정보없음") null else td[0].text().trim() to v
    }.toMap()

    override fun animeDetailsParse(response: Response): SAnime {
        val html = response.body.string()
        val doc = Jsoup.parse(html, response.request.url.toString())
        val m = meta(doc)
        // 방영 중: 정보 "총화수" 칸이 "방영중" 이거나 경로(BreadcrumbList) 두 번째가 "방영중"
        val ongoing = m["총화수"].orEmpty().contains("방영중") || html.contains("\"position\":2,\"name\":\"방영중\"")
        val eps = episodesOf(doc)
        val latest = eps.mapNotNull { it.date }.maxOrNull()
        val year = YEAR_REGEX.find(m["방영일"] ?: m["상영일"] ?: m["개봉일"] ?: "")?.value
        return SAnime.create().apply {
            val t = titleOf(doc)
            title = if (!ongoing && year != null && !t.contains("($year)")) "$t ($year)" else t
            thumbnail_url = doc.selectFirst(".detail-description .animation-image img")?.attr("abs:src")?.ifEmpty { null }
            genre = m["장르"]?.split(',', '/', '·')?.map { it.trim() }?.filter { it.isNotEmpty() }?.joinToString(", ")?.ifEmpty { null }
            author = m["원작"]
            artist = m["감독"]
            status = if (ongoing) SAnime.ONGOING else SAnime.COMPLETED
            if (m.containsKey("상영일")) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            val story = doc.selectFirst(".detail-synopsis span.text-default")?.let { p ->
                p.select("br").append("\\n")
                p.text().replace("\\n", "\n").lines().map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n")
            }
            val info = listOf("원제", "원작", "감독", "각본", "작화", "음악", "방영일", "상영일", "등급", "총화수", "런타임")
                .mapNotNull { k -> m[k]?.let { "$k: $it" } }
                .joinToString("\n")
            description = listOfNotNull(
                if (ongoing && latest != null) "방영 중 · 최근 방영: ${synchronized(OUT_FMT) { OUT_FMT.format(latest) }}" else null,
                story?.ifEmpty { null },
                info.ifEmpty { null },
            ).joinToString("\n\n")
        }
    }

    private fun titleOf(doc: Document): String =
        doc.selectFirst("h1.aw-h1, .detail-title h1")?.text()?.trim().orEmpty()

    // ================= 회차 =================
    private class Ep(val path: String, val label: String, val number: Float?, val date: java.util.Date?)

    private fun episodesOf(doc: Document): List<Ep> {
        val title = titleOf(doc)
        val seen = HashSet<String>()
        return doc.select(".bg-episode").mapNotNull { row ->
            val a = row.selectFirst("a[href]") ?: return@mapNotNull null
            val path = pathOf(a.attr("abs:href")) ?: return@mapNotNull null
            if (path.count { it == '/' } != 2 || !seen.add(path)) return@mapNotNull null
            // 지금 보는 회차 표시 "(시청중)" 은 뺌, 앞의 작품 제목도 뺌 (극장판은 "제목 제목" 처럼 두 번 붙음)
            var label = a.text().replace("(시청중)", "").replace(Regex("""\s+"""), " ").trim()
            while (title.isNotEmpty() && label.startsWith(title) && label.length > title.length) label = label.substring(title.length).trim()
            if (label.isEmpty()) label = path.substringAfterLast('/')
            val dateText = row.selectFirst(".text-white-50")?.text().orEmpty()
            val date = DATE_REGEX.find(dateText)?.value?.let { d -> runCatching { synchronized(IN_FMT) { IN_FMT.parse(d) } }.getOrNull() }
            Ep(path, label, EP_NUM_REGEX.find(label)?.groupValues?.get(1)?.toFloatOrNull(), date)
        }
    }

    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + workOf(anime.url), h())

    // 영화 회차 이름은 "본편" 으로 통일 (MovieName)
    override fun episodeListParse(response: Response): List<SEpisode> = MovieName.unify(parseEpisodes(response))

    private fun parseEpisodes(response: Response): List<SEpisode> {
        val doc = Jsoup.parse(response.body.string(), response.request.url.toString())
        val eps = episodesOf(doc)
        val used = HashSet<Float>()
        // 사이트는 최신 회차가 위 → 아래에서부터 차례 번호를 매김
        return eps.reversed().mapIndexed { i, ep ->
            var n = ep.number ?: (i + 1).toFloat()
            while (!used.add(n)) n += 0.01f
            SEpisode.create().apply {
                url = ep.path
                name = ep.label + (ep.date?.let { d -> " (${synchronized(SHORT_FMT) { SHORT_FMT.format(d) }})" } ?: "")
                episode_number = n
                date_upload = ep.date?.time ?: 0L
            }
        }.reversed()
    }

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        // 회차 주소에 한글이 있음("/원피스/001화") → 요청 머리글(Referer)에는 한글을 못 넣으므로 %XX 로 바꾼 주소를 씀
        // (8752 에서 재생 화면 요청이 이 때문에 실패해 "No available videos", 2026-11-04)
        val pageUrl = (baseUrl + episode.url).toHttpUrl().toString()
        val doc = client.newCall(GET(pageUrl, h())).execute().use { res ->
            if (!res.isSuccessful) throw Exception("회차 화면을 열지 못했습니다 (HTTP ${res.code})")
            Jsoup.parse(res.body.string(), res.request.url.toString())
        }
        // 회차 화면의 재생 버튼 주소(mov.glamov.com/detail.php?v=…) → 그 화면의 iframe 이 플레이어(cdndania.com/video/…)
        val html = doc.outerHtml()
        val views = (VIEW_REGEX.findAll(html).map { it.value.replace("&amp;", "&") } +
            doc.select("input[name=v][value]").map { "https://mov.glamov.com/detail.php?v=${it.attr("value")}" }).distinct().toList()
        val players = mutableListOf<Pair<String, String>>()
        for (v in views) {
            runCatching {
                client.newCall(GET(v, h().newBuilder().set("Referer", pageUrl).build())).execute().use { res ->
                    if (res.isSuccessful) {
                        Jsoup.parse(res.body.string(), res.request.url.toString()).select("iframe[src]").map { it.attr("abs:src") }
                            .filter { it.startsWith("http") && !AD_REGEX.containsMatchIn(it) }
                            .forEach { p -> if (players.none { it.first == p }) players.add(p to v) }
                    }
                }
            }
        }
        // 회차 화면에 플레이어가 바로 있는 경우도
        doc.select("iframe[src]").map { it.attr("abs:src") }.filter { PLAYER_REGEX.containsMatchIn(it) }
            .forEach { p -> if (players.none { it.first == p }) players.add(p to pageUrl) }
        if (players.isEmpty()) throw Exception("이 회차에는 재생 화면이 없습니다 [재생 버튼 ${views.size}개]")
        val errors = mutableListOf<String>()
        val out = mutableListOf<Video>()
        players.forEachIndexed { i, (player, from) ->
            val label = if (i == 0) LABEL else "$LABEL (대체 $i)"
            val found = runCatching { firePlayer(player, from) }.getOrNull()
                ?: sniffWithWebView(player, from)
            if (found == null) {
                errors.add(player.toHttpUrlOrNull()?.host ?: player)
                return@forEachIndexed
            }
            val vh = videoHeaders(found.second)
            out += HlsQuality.expand(client, found.first, label, vh)
        }
        if (out.isEmpty()) throw Exception("영상 주소를 찾지 못했습니다 [${errors.joinToString()}]")
        HlsQuality.sort(prefs(), out)
    }

    /**
     * 플레이어(cdndania 등, 애니24와 같은 종류)가 스스로 부르는 영상 주소 요청을 그대로 함:
     * POST {플레이어}/player/index.php?data={영상ID}&do=getVideo (hash={영상ID}, r={회차 화면}) → JSON 안의 m3u8
     */
    private fun firePlayer(player: String, pageUrl: String): Pair<String, String>? {
        val u = player.toHttpUrlOrNull() ?: return null
        val vid = u.pathSegments.lastOrNull { it.isNotEmpty() } ?: return null
        val origin = "${u.scheme}://${u.host}"
        // 애니24(DC 애니24)와 같은 요청: Referer·Origin 은 플레이어 주소 앞부분, r 은 빈 값
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
    // 맨 위에 최근 업데이트 내역(📝)
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("aniwolf", baseFilters())

    private fun baseFilters(): AnimeFilterList {
        fun text(i: IntArray) = listOfNotNull(
            KINDS[i[0]].first,
            DAYS[i[1]].first.takeIf { i[0] == 0 && i[1] > 0 },
            if (i[0] == 3) PERIODS[i[3]].first else SORTS[i[2]].first,
        ).joinToString(" · ")
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}"),
                AnimeFilter.Separator(),
                AnimeFilter.Header("검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)"),
                KindFilter(),
                DayFilter(),
                SortFilter(),
                PeriodFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class KindFilter : AnimeFilter.Select<String>("분류", KINDS.map { it.first }.toTypedArray())
    class DayFilter : AnimeFilter.Select<String>("요일 (방영중만)", DAYS.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬 (순위 빼고)", SORTS.map { it.first }.toTypedArray())
    class PeriodFilter : AnimeFilter.Select<String>("순위 기간 (순위만)", PERIODS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "애니울프 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다. 사이트가 새 주소로 넘겨 주면 자동으로 저장됩니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 애니울프 주소 (예: https://aniwolf.com)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://aniwolf.com)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val DEFAULT_BASE_URL = "https://aniwolf.com"
        private const val RATE_GAP_MS = 300L
        private const val LABEL = "애니울프"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?aniwolf\d*\.[a-z]{2,6}$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?aniwolf\d*\.[a-z]{2,6}$""")
        private val PASTE_REGEX = Regex("""aniwolf\d*\.[a-z]{2,6}(/[^?#\s]+)""")
        private val WORK_PATH = Regex("""^/[^/]+(/[^/]+)?$""")
        private val RESERVED = Regex("""^/(history|community|bookmark|signin|signup|go|assets|storage|api|img)(/|$)""")
        private val VIEW_REGEX = Regex("""https?://[^"'\s<>]+/detail\.php\?v=[0-9a-zA-Z]+""")
        private val PLAYER_REGEX = Regex("""cdndania|michealcdn|/video/""")
        private val AD_REGEX = Regex("""googlesyndication|doubleclick|/ads?[/.]""")
        private val YEAR_REGEX = Regex("""(?:19|20)\d{2}""")
        private val YEAR_ONLY = Regex("""^(?:19|20)\d{2}$""")
        private val DATE_REGEX = Regex("""\d{4}/\d{1,2}/\d{1,2}""")
        private val EP_NUM_REGEX = Regex("""(\d+(?:\.\d+)?)\s*화""")
        private val M3U8_REGEX = Regex("""https?://[^"'\s<>]+\.m3u8[^"'\s<>]*""")

        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val IN_FMT = SimpleDateFormat("yyyy/MM/dd", Locale.KOREA).apply { timeZone = KST }
        private val OUT_FMT = SimpleDateFormat("yyyy.MM.dd (E)", Locale.KOREA).apply { timeZone = KST }
        private val SHORT_FMT = SimpleDateFormat("MM.dd", Locale.KOREA).apply { timeZone = KST }

        private val KINDS = listOf("방영중" to "ing", "종영" to "fin", "극장판" to "film", "순위" to "rank")

        /** 요일 (사이트 값 u=전체, 1=월 … 6=토, 0=일) */
        private val DAYS = listOf("전체" to "u", "월" to "1", "화" to "2", "수" to "3", "목" to "4", "금" to "5", "토" to "6", "일" to "0")
        private val SORTS = listOf("최신" to "new", "인기" to "hot")
        private val PERIODS = listOf("실시간" to "now", "일간" to "day", "주간" to "week", "월간" to "month")

        private val DEFAULT_POPULAR = intArrayOf(0, 0, 1, 0)
        private val DEFAULT_LATEST = intArrayOf(0, 0, 0, 0)

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "magsrv.com",
            "runative-syndicate.com",
        )
    }
}
