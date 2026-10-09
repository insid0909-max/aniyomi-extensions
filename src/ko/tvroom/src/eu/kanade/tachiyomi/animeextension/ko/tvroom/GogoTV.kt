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
import java.io.ByteArrayInputStream
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 고고티비 (gogotv숫자.xyz).
 * fixedCat 을 주면 그 분류만 보는 소스("고고티비 드라마" 등)가 된다. 주소·도메인 자동 찾기 설정은 기본 고고티비 소스와 함께 쓴다.
 */
class GogoTV(private val fixedCat: Int = -1) : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = if (fixedCat < 0) "고고티비" else "고고티비 ${CATEGORY_NAMES[fixedCat]}"
    override val lang = "ko"
    override val supportsLatest = true

    // ================= 주소와 설정 =================
    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    // 주소·도메인 자동 찾기는 분류별 소스도 기본 고고티비 소스의 설정을 같이 씀
    private fun sitePrefs(): SharedPreferences? = if (fixedCat < 0) {
        prefs()
    } else {
        runCatching {
            val app = Class.forName("android.app.ActivityThread")
                .getMethod("currentApplication")
                .invoke(null) as? Application
            app?.getSharedPreferences("source_${generateId("고고티비", lang, versionId)}", 0)
        }.getOrNull()
    }

    override val baseUrl: String
        get() {
            val custom = sitePrefs()?.getString(PREF_DOMAIN_KEY, "")?.trim()?.trimEnd('/').orEmpty()
            return if (DOMAIN_REGEX.matches(custom)) DomainGuard.preferDefault(custom, DEFAULT_BASE_URL) else DEFAULT_BASE_URL
        }

    private fun autoDomain(): Boolean = sitePrefs()?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

    private fun saveDomain(url: String) {
        sitePrefs()?.edit()?.putString(PREF_DOMAIN_KEY, url)?.apply()
    }

    // 주소 번호가 바뀌어 접속이 안 되면 gogotv 번호 주소를 찾아 자동 연결
    override val client: OkHttpClient = network.client.newBuilder()
        .addInterceptor(PageCache(Regex("^/player/")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS))
        .addInterceptor { chain -> domainIntercept(chain) }
        .addInterceptor(NoticeFollow(HOST_REGEX, "/player/"))
        .addInterceptor(RetryOnce(HOST_REGEX))
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
            ?: filterRequest(page, intArrayOf(maxOf(fixedCat, 0), 1, 0))

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun latestUpdatesRequest(page: Int): Request =
        TabRule.read(prefs(), false, RULE_SIZES)?.let { filterRequest(page, it) }
            ?: filterRequest(page, intArrayOf(maxOf(fixedCat, 0), 0, 0))

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response.asDoc())

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        // 사이트 작품 주소를 붙여 넣으면 그 작품을 바로 보여 줌 (주소 번호가 달라도 됨)
        URL_PLAYER_REGEX.find(query.trim())?.let { m ->
            return GET("$baseUrl/player/${m.groupValues[1]}", h())
        }
        if (query.isNotBlank()) {
            // 사이트 검색창과 같은 주소: /search/검색어 (?page=N)
            val url = "$baseUrl/search/".toHttpUrl().newBuilder()
                .addPathSegment(query.trim())
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

    /** idx = [분류, 정렬, 지역] 선택 번호 (분류별 소스는 분류가 고정) */
    private fun filterRequest(page: Int, idx: IntArray): Request {
        val cat = if (fixedCat >= 0) fixedCat else idx[0]
        return GET(listUrl(CATEGORIES[cat].second, SORTS[idx[1]].second, COUNTRIES[idx[2]].second, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val url = response.request.url
        if (url.encodedPath.startsWith("/player/")) {
            // 주소로 찾은 작품 하나
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { this.url = url.encodedPath }), false)
        }
        return parseList(response.asDoc())
    }

    private fun parseList(doc: Document): AnimesPage {
        // 검색 결과 화면은 모양이 달라 따로 읽음
        if (doc.selectFirst(".search-page a[href*=/player/]") != null) return parseSearch(doc)
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
                // 방영이 끝났으면 제목 뒤에 연도 (사이트 제목에 없으면 마지막 방영 연도).
                // 방영 중이면 날짜를 붙이지 않음 (서재에 담긴 작품은 제목이 갱신되지 않아 날짜가 굳어 버림)
                val date = dl.selectFirst(".date")?.text().orEmpty()
                val air = airLabel(date)
                if (title.isNotEmpty() && air != null) {
                    title = title.replace(TITLE_YEAR_REGEX, "")
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

    /** 검색 결과: li > .search-page(포스터·링크) + .view-floor2-lf-cont .tit(제목, 검색어 강조 표시 포함) */
    private fun parseSearch(doc: Document): AnimesPage {
        val seen = HashSet<String>()
        val animes = doc.select(".search-page").mapNotNull { box ->
            val li = box.parent() ?: return@mapNotNull null
            val a = box.selectFirst("a[href*=/player/]") ?: return@mapNotNull null
            val path = pathOf(a.attr("href"))
            if (!seen.add(path)) return@mapNotNull null
            SAnime.create().apply {
                url = path
                title = li.selectFirst(".view-floor2-lf-cont .tit")?.text()?.trim().orEmpty()
                thumbnail_url = a.selectFirst("img")?.absUrl("src")?.ifEmpty { null }
                airLabel(li.selectFirst(".date")?.text().orEmpty())?.let {
                    if (title.isNotEmpty()) title = title.replace(TITLE_YEAR_REGEX, "")
                }
            }
        }.filter { it.title.isNotEmpty() }
        return AnimesPage(animes, hasNextPage(doc))
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
            // 방영 중/종영 판단은 목록 카드와 같은 기준: 가장 최근 회차가 최종회가 아니고 21일 안이면 방영 중
            // 제목도 목록 카드와 똑같이 (애니요미는 한 번 연 작품을 목록에서 이 제목으로 보여 줌):
            // 방영 중 "제목"(최근 방영일은 설명 맨 위), 끝났으면 "제목 (2026)" (사이트 제목에 연도가 없으면 방영 시작 연도, 그것도 없으면 마지막 방영 연도)
            val epLabels = doc.select(".view-floor1-rt-cont li p.left a").map { it.text().replace(ICON_REGEX, "").trim() }
            val newest = epLabels.maxByOrNull { dateOf(it) }?.takeIf { dateOf(it) > 0 }
            val air = newest?.let { airLabel(it) }
            val periodText = doc.select(".view-floor2-lf-cont .list .right").map { it.text() }.firstOrNull { it.contains("~") }
            val year = periodText?.let { PERIOD_YEAR_REGEX.find(it)?.groupValues?.get(1) }
                ?: newest?.let { CARD_DATE_REGEX.find(it)?.groupValues?.get(1) }?.let { "20$it" }
            title = when {
                air != null -> name.replace(TITLE_YEAR_REGEX, "")
                year != null && !TITLE_YEAR_REGEX.containsMatchIn(name) -> "$name ($year)"
                else -> name
            }
            thumbnail_url = doc.selectFirst(".view-floor2-lf-img img")?.absUrl("src")?.ifEmpty { null }
            val info = doc.select(".view-floor2-lf-cont .list .right").map { it.text().trim() }
                .filter { it.isNotEmpty() }
            val plot = doc.selectFirst(".view-floor2-lf-cont .cont")?.text()?.trim().orEmpty()
            val latest = newest?.let { dateOf(it) } ?: 0L
            // 날짜 있는 회차가 없으면 영화: 회차가 늘지 않으므로 서재 업데이트 때 다시 확인하지 않음
            if (newest == null && epLabels.isNotEmpty()) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            status = when {
                air != null -> SAnime.ONGOING
                latest > 0 || periodText != null -> SAnime.COMPLETED
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
    /** 작품 페이지의 회차 링크 (주소, 이름). 주소(send5video go.php?key=…)는 시간이 지나면 만료됨 */
    private fun episodeLinks(doc: Document): List<Pair<String, String>> =
        doc.select(".view-floor1-rt-cont li").mapNotNull { li ->
            val a = li.selectFirst("p.left a[href]") ?: li.selectFirst("a[href]") ?: return@mapNotNull null
            val href = a.absUrl("href").ifEmpty { return@mapNotNull null }
            // 아이콘 글꼴 문자 제거
            href to a.text().replace(ICON_REGEX, "").trim().ifEmpty { "바로보기" }
        }.distinctBy { it.first }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val links = episodeLinks(doc)
        // 회차 주소는 만료되므로 "작품 주소#ep=회차 이름" 으로 저장하고, 재생할 때 작품 페이지에서 새 주소를 받음
        val detailPath = response.request.url.encodedPath

        return links.mapIndexed { i, (href, label) ->
            val no = EP_REGEX.find(label)?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }?.toFloatOrNull()
            val d = CARD_DATE_REGEX.find(label)
            SEpisode.create().apply {
                url = if (href.startsWith(baseUrl)) href.removePrefix(baseUrl) else "$detailPath#ep=" + URLEncoder.encode(label, "UTF-8")
                // "제19회 26/10/04 - 최종회" → "19회 (10.04) 최종회" 처럼 보기 좋게 (날짜가 없으면 그대로)
                name = if (no != null && d != null) {
                    val note = label.substringAfter(" - ", "").trim()
                    "${no.toInt()}회 (${d.groupValues[2]}.${d.groupValues[3]})" + if (note.isNotEmpty()) " $note" else ""
                } else {
                    label
                }
                date_upload = dateOf(label)
                episode_number = no ?: (links.size - i).toFloat()
            }
        }
    }

    override fun getEpisodeUrl(episode: SEpisode): String =
        if (episode.url.startsWith("http")) episode.url else baseUrl + episode.url.substringBefore("#ep=")

    // ================= 영상 =================
    override fun videoListRequest(episode: SEpisode): Request {
        val u = episode.url
        // 새 방식: 작품 페이지를 열어 그 회차의 지금 주소를 받음 (이름은 tag 로 넘김)
        if (!u.startsWith("http") && u.contains("#ep=")) {
            val label = URLDecoder.decode(u.substringAfter("#ep="), "UTF-8")
            return GET(baseUrl + u.substringBefore("#ep="), headersBuilder().set("Referer", "$baseUrl/").build())
                .newBuilder().tag(String::class.java, label).build()
        }
        return GET(if (u.startsWith("http")) u else baseUrl + u, headersBuilder().set("Referer", "$baseUrl/").build())
    }

    override fun videoListParse(response: Response): List<Video> {
        var pageUrl = response.request.url.toString()
        var html = response.body.string()
        response.request.tag(String::class.java)?.let { label ->
            // 작품 페이지에서 같은 이름(없으면 같은 회차 번호)의 지금 주소를 찾아 열기
            val links = episodeLinks(Jsoup.parse(html, pageUrl))
            val no = EP_REGEX.find(label)?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }
            val href = links.firstOrNull { it.second == label }?.first
                ?: links.firstOrNull { l -> no != null && EP_REGEX.find(l.second)?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() } == no }?.first
                ?: throw Exception("이 회차를 작품 페이지에서 찾지 못했습니다. 회차 목록을 새로고침해 주세요: $label")
            client.newCall(GET(href, headersBuilder().set("Referer", pageUrl).build())).execute().use { r ->
                if (!r.isSuccessful) throw Exception("회차 주소를 열지 못했습니다 (HTTP ${r.code})")
                pageUrl = r.request.url.toString()
                html = r.body.string()
            }
        }

        val pageHeaders = headersBuilder().set("Referer", pageUrl).build()
        val iframes = Jsoup.parse(html, pageUrl).select("iframe[src]")
            .map { it.absUrl("src") }.filter { it.startsWith("http") }.take(3)
        fun mediaIn(src: String) = runCatching {
            client.newCall(GET(src, pageHeaders)).execute().use { findAllMedia(it.body.string()) }
        }.getOrDefault(emptyList())

        // 설정 "다른 서버도 함께 찾기"가 꺼져 있으면(기본): 후보를 하나씩 열어 보고 처음 열리는 영상으로 바로 재생
        // (나머지 후보는 열지 않아 재생이 빨리 시작됨)
        if (!(prefs()?.getBoolean(PREF_OTHER_SERVERS, false) ?: false)) {
            val tried = ArrayList<Pair<String, String>>()
            // 회차 주소가 중간 페이지(send5video go.php → 자동 제출 폼 → 플레이어)면 망가요미처럼 직접 따라가서 찾음
            val first = sequence {
                yieldAll(findAllMedia(html).map { it to pageUrl })
                yieldAll(crawlMedia(html, pageUrl))
            }.distinctBy { it.first }.take(4).onEach { tried.add(it) }
                .firstOrNull { (m, r) -> HlsQuality.works(client, m, videoHeaders(r)) }
            val (m, r) = first ?: sniffWithWebView(pageUrl) ?: tried.firstOrNull()
                ?: throw Exception("영상 주소를 찾지 못했습니다: $pageUrl")
            return HlsQuality.sort(prefs(), HlsQuality.expand(client, m, qualityOf(m), videoHeaders(r)))
        }

        // 1) 페이지와 그 안 iframe 들에 들어 있는 영상 주소 후보를 모두 모음 (최대 4개)
        val candidates = (findAllMedia(html) + iframes.flatMap { mediaIn(it) }).distinct().take(4)

        // 2) 실제로 열리는 후보만. 하나도 없으면 숨은 화면(WebView)으로 열어 영상 요청을 가로챈다 (자동 전환)
        val working = candidates.filter { HlsQuality.works(client, it, pageHeaders) }
        val (media, referer) = working.firstOrNull()?.let { it to pageUrl } ?: sniffWithWebView(pageUrl)
            ?: candidates.firstOrNull()?.let { it to pageUrl }
            ?: throw Exception("영상 주소를 찾지 못했습니다: $pageUrl")

        val vh = videoHeaders(referer)
        val quality = qualityOf(media)
        // 열리는 다른 후보는 "(대체 N)" 으로 뒤에 붙여 플레이어에서 바로 바꿀 수 있게
        val extras = working.filter { it != media }.mapIndexed { i, u ->
            Video(u, "${HlsQuality.withRes(qualityOf(u), u)} (대체 ${i + 1})", u, videoHeaders(pageUrl))
        }
        return HlsQuality.sort(prefs(), HlsQuality.expand(client, media, quality, vh)) + extras
    }

    private fun qualityOf(url: String) = if (url.contains(".m3u8")) "고고티비 (HLS)" else "고고티비"

    private fun videoHeaders(referer: String): Headers {
        val origin = referer.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" }
        return Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", referer)
            .apply { if (origin != null) set("Origin", origin) }
            .build()
    }

    /**
     * 중간 페이지를 따라가며 영상 주소를 찾음 (망가요미 고고티비와 같은 방식): 자동 제출 폼(숨은 값을 붙인 주소),
     * meta refresh, location.href, iframe(data-src·src). 최대 3단계·10페이지. (영상 주소, 그 영상을 찾은 페이지) 를 차례로 내놓음
     */
    private fun crawlMedia(startHtml: String, startUrl: String): Sequence<Pair<String, String>> = sequence {
        val visited = HashSet<String>().apply { add(startUrl) }
        val queue = ArrayDeque<Triple<String, String, Int>>()
        nextTargets(startHtml, startUrl).forEach { queue.add(Triple(it, startUrl, 1)) }
        while (queue.isNotEmpty() && visited.size < 10) {
            val (url, referer, depth) = queue.removeFirst()
            if (!visited.add(url)) continue
            val body = runCatching {
                client.newCall(GET(url, headersBuilder().set("Referer", referer).build())).execute()
                    .use { it.body.string() }
            }.getOrNull() ?: continue
            val found = findAllMedia(body)
            if (found.isNotEmpty()) {
                yieldAll(found.map { it to url })
                continue
            }
            if (depth < 3) nextTargets(body, url).forEach { queue.add(Triple(it, url, depth + 1)) }
        }
    }

    private fun nextTargets(html: String, pageUrl: String): List<String> {
        val doc = Jsoup.parse(html, pageUrl)
        val out = LinkedHashSet<String>()
        fun add(u: String) {
            if (u.startsWith("http")) out.add(u)
        }
        // 자동 제출 폼 (GET): action + 숨은 입력값
        doc.select("form[action]").toList().filter { it.attr("method").ifEmpty { "get" }.equals("get", true) }.forEach { f ->
            val b = f.absUrl("action").toHttpUrlOrNull()?.newBuilder() ?: return@forEach
            f.select("input[name]").forEach { b.addQueryParameter(it.attr("name"), it.attr("value")) }
            add(b.build().toString())
        }
        Regex("""http-equiv=["']?refresh["']?[^>]+url=([^"'>\s]+)""", RegexOption.IGNORE_CASE).findAll(html)
            .forEach { add(doc.location().toHttpUrlOrNull()?.resolve(it.groupValues[1])?.toString().orEmpty()) }
        Regex("""(?:location\.href|location\.replace|window\.location)\s*(?:=|\()\s*["']([^"']+)["']""").findAll(html)
            .forEach { add(doc.location().toHttpUrlOrNull()?.resolve(it.groupValues[1])?.toString().orEmpty()) }
        doc.select("iframe").forEach { f -> add(f.absUrl("data-src").ifEmpty { f.absUrl("src") }) }
        return out.take(6)
    }

    private fun findAllMedia(text: String): List<String> =
        MEDIA_REGEX.findAll(text.replace("\\/", "/")).map { it.value }.distinct().toList()

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
            listOfNotNull(
                AnimeFilter.Header("검색어가 없을 때만 적용"),
                CategoryFilter().takeIf { fixedCat < 0 },
                SortFilter(),
                CountryFilter(),
            ) + TabRule.filters(prefs(), RULE_SIZES, "${catName()} · 주간인기순" to "${catName()} · 업데이트순") {
                (if (fixedCat < 0) "${CATEGORIES[it[0]].first} · " else "") +
                    "${SORTS[it[1]].first} · ${COUNTRIES[it[2]].first}"
            },
        ),
    )

    private fun catName(): String = CATEGORY_NAMES[maxOf(fixedCat, 0)]

    class CategoryFilter : AnimeFilter.Select<String>("분류", CATEGORIES.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())
    class CountryFilter : AnimeFilter.Select<String>("지역", COUNTRIES.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        if (fixedCat >= 0) {
            // 분류별 소스: 주소·도메인 자동 찾기는 기본 "고고티비" 소스 설정에서 (같이 적용됨)
            HlsQuality.addPreference(screen)
            return
        }
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

        SwitchPreferenceCompat(ctx).apply {
            key = PREF_OTHER_SERVERS
            title = "다른 서버도 함께 찾기"
            summary = "켜면 재생 목록에 다른 영상 후보((대체 N))도 붙여서, 플레이어에서 바로 바꿀 수 있어요. " +
                "끄면(기본) 처음 열리는 영상으로 바로 재생해서 더 빨리 시작돼요. 영화·드라마 소스에도 같이 적용."
            setDefaultValue(false)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    // ================= 공용 =================
    private fun pathOf(href: String): String = PATH_REGEX.find(href)?.groupValues?.get(1) ?: href

    private fun Response.asDoc(): Document = Jsoup.parse(body.string(), request.url.toString())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val PREF_OTHER_SERVERS = "pref_other_servers"
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

        private val BLOCKED_HOSTS = listOf(
            "googletagmanager.com",
            "google-analytics.com",
            "waust.at",
            "51.la",
            "cloudflareinsights.com",
        )

        /** 분류별 소스 이름 (CATEGORIES 와 같은 순서). TV프로 = 시사·교양 */
        internal val CATEGORY_NAMES = listOf("드라마", "영화", "예능", "시사", "음악프로", "애니")

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
