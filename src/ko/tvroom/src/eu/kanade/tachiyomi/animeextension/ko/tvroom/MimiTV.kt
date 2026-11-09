package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.annotation.SuppressLint
import android.app.Application
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import rx.Observable
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Collections
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 미미티비 (mimitv13.com, 2026-11-09 다시 만듦 — 망가요미 mimitv.js 0.1.8 과 같은 규칙. 예전 애니요미판은 TVroom 8725 에서 삭제했었음).
 * 목록 /show.php?tid=분류&class=장르&order_type=(빈 값 최신|vod_hits 인기)&limit=24&page=N, 카드 div.item,
 * 검색 /search.php?keyword=, 작품 /shplay.php?id=N (회차는 화면 글자 안 manualSeasons).
 * 재생: 플레이어(xiaoca.top/one/onet.php?url=…)의 url= 주소는 가짜. 플레이어가 스스로 진짜 주소를 풀어 요청하므로
 * 숨은 화면(WebView)으로 플레이어를 열어 그 m3u8 요청을 받음 (암호를 확장이 직접 풀지 않음).
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

    // 직접 넣은 주소는 바로, 더 새 주소가 확인되면 자동으로 바뀜 (DomainGuard.pick)
    override val baseUrl: String
        get() = DomainGuard.pick(prefs(), PREF_DOMAIN_KEY, DEFAULT_BASE_URL, autoDomain(), { DOMAIN_REGEX.matches(it) })

    override val client: OkHttpClient = network.client.newBuilder()
        .apply { interceptors().add(0, FriendlyNet) }
        .addInterceptor(PageCache(Regex("^/shplay\\.php")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS, skipImages = true))
        .addInterceptor { chain ->
            // 사이트가 새 주소로 넘겨 주면(200 일 때만) 그 주소를 저장
            val res = chain.proceed(chain.request())
            val from = chain.request().url.host
            val to = res.request.url.host
            if (res.code == 200 && from != to && HOST_REGEX.matches(from) && HOST_REGEX.matches(to)) {
                DomainGuard.saveAuto(prefs(), PREF_DOMAIN_KEY, "https://$to")
            }
            res
        }
        .addInterceptor { chain -> domainIntercept(chain) }
        .addInterceptor(NoticeFollow(HOST_REGEX, SITE_MARKER))
        .addInterceptor(RetryOnce(HOST_REGEX))
        .build()

    // ================= 도메인 자동 찾기 =================
    private fun autoDomain(): Boolean = prefs()?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val baseHost = baseUrl.toHttpUrlOrNull()?.host
        if (baseHost == null || req.url.host != baseHost || !autoDomain()) return chain.proceed(req)

        fun retryOn(found: String): Response {
            DomainGuard.saveAuto(prefs(), PREF_DOMAIN_KEY, "https://$found")
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(found).build()).build())
        }

        val res = try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            val found = discoverDomain(baseHost) ?: throw e
            return retryOn(found)
        }
        val dead = !HOST_REGEX.matches(res.request.url.host) || res.code == 451 || res.code >= 500
        if (req.method == "GET" && dead) {
            val found = discoverDomain(baseHost) ?: return res
            res.close()
            return retryOn(found)
        }
        return res
    }

    private val plain by lazy {
        OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    /** 진짜 미미티비 첫 화면이면 그 host (넘겨 준 주소도 200 + 표시 글자 확인) */
    private fun realHost(host: String): String? = runCatching {
        val r = Request.Builder().url("https://$host/").header("User-Agent", USER_AGENT).build()
        plain.newCall(r).execute().use { res ->
            val fh = res.request.url.host
            val body = res.peekBody(400_000).string()
            if (HOST_REGEX.matches(fh) && res.code == 200 && body.contains(SITE_MARKER) && body.contains("미미티비")) fh else null
        }
    }.getOrNull()

    @Volatile private var lastDiscover = 0L

    /** 저장소 주소 목록 → 평생 주소 안내 페이지(미미티비주소.com)에 적힌 주소 → 번호 짐작 (1분에 한 번) */
    private fun discoverDomain(currentHost: String): String? = synchronized(DISCOVER_LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now
        DomainList.host("mimitv")?.takeIf { HOST_REGEX.matches(it) && it != currentHost }?.let { listed ->
            realHost(listed)?.let { return it }
        }
        val guided = runCatching {
            plain.newCall(Request.Builder().url(GUIDE_URL).header("User-Agent", USER_AGENT).build()).execute().use { r ->
                NUM_REGEX.findAll(r.body.string().lowercase()).mapNotNull { it.groupValues[1].toIntOrNull() }
                    .filter { it > 0 }.distinct().sortedDescending().take(3).toList()
            }
        }.getOrDefault(emptyList())
        for (g in guided) {
            val h = "mimitv$g.com"
            if (h != currentHost) realHost(h)?.let { return it }
        }
        val n = NUM_REGEX.find(currentHost)?.groupValues?.get(1)?.toIntOrNull() ?: DomainGuard.hostNumber(DEFAULT_BASE_URL)
        val candidates = ((1..8).map { "mimitv${n + it}.com" } + (1..3).mapNotNull { (n - it).takeIf { v -> v > 0 }?.let { v -> "mimitv$v.com" } })
            .filter { it != currentHost }
        val pool = java.util.concurrent.Executors.newFixedThreadPool(8)
        try {
            val futures = candidates.map { h -> pool.submit<String?> { realHost(h) } }
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
    private fun listUrl(idx: IntArray, page: Int): String {
        val b = "$baseUrl/show.php".toHttpUrl().newBuilder()
        CATEGORIES[idx[0]].second.takeIf { it.isNotEmpty() }?.let { b.addQueryParameter("tid", it) }
        if (idx[1] > 0) b.addQueryParameter("class", GENRES[idx[1]])
        b.addQueryParameter("order_type", SORTS[idx[2]].second)
        if (page > 1) {
            b.addQueryParameter("limit", "24")
            b.addQueryParameter("page", page.toString())
        }
        return b.build().toString()
    }

    private fun ruleSizes() = intArrayOf(CATEGORIES.size, GENRES.size, SORTS.size)

    private fun isMovieCat(url: okhttp3.HttpUrl) = url.queryParameter("tid") in MOVIE_TIDS

    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    // 사이트 주소(mimitvN.com)를 붙여 넣으면 진짜 사이트인지 확인 후 직접 넣은 주소로 바로 적용 (작품 주소면 그 작품)
    // 검색 결과가 없으면 띄어쓰기 뺀 검색어 등으로 다시 찾음 (SearchSpacing)
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val pasted = PASTE_HOST_REGEX.find(query.trim())?.groupValues?.get(1)?.lowercase()
        if (pasted != null && page == 1) {
            return Observable.fromCallable { realHost(pasted) }.flatMap<AnimesPage> { real ->
                if (real != null) prefs()?.edit()?.putString(PREF_DOMAIN_KEY, "https://$real")?.apply()
                when {
                    ID_REGEX.containsMatchIn(query) -> super.fetchSearchAnime(page, query, filters)
                    real != null -> fetchPopularAnime(1)
                    else -> Observable.error<AnimesPage>(Exception("미미티비 주소가 아니거나 열리지 않아요: $pasted"))
                }
            }
        }
        return SearchSpacing.wrap(page, query) { q, p -> super.fetchSearchAnime(p, q, filters) }
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        // 작품 주소를 붙여 넣으면 그 작품을 바로 열기 (주소 번호가 달라도 됨)
        ID_REGEX.find(query.trim())?.let { m -> return GET("$baseUrl/shplay.php?id=${m.groupValues[1]}", h()) }
        val q = query.trim()
        if (q.isNotEmpty()) {
            val url = "$baseUrl/search.php".toHttpUrl().newBuilder()
                .addQueryParameter("keyword", q)
                .apply {
                    if (page > 1) {
                        addQueryParameter("limit", "24")
                        addQueryParameter("page", page.toString())
                    }
                }
                .build()
            return GET(url.toString(), h())
        }
        val idx = intArrayOf(
            filters.filterIsInstance<CategoryFilter>().firstOrNull()?.state ?: DEFAULT_LATEST[0],
            filters.filterIsInstance<GenreFilter>().firstOrNull()?.state ?: 0,
            filters.filterIsInstance<SortFilter>().firstOrNull()?.state ?: 0,
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val url = response.request.url
        if (url.encodedPath.startsWith("/shplay.php")) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { this.url = "/shplay.php?id=${url.queryParameter("id")}" }), false)
        }
        return parseList(response)
    }

    /** 목록·검색 공통: 작품 카드 (div.item). 영화 분류면 제목 뒤에 (연도) */
    private fun parseList(response: Response): AnimesPage {
        val movie = isMovieCat(response.request.url)
        val doc = response.asDoc()
        val seen = HashSet<String>()
        val animes = doc.select("div.item").mapNotNull { item ->
            val a = item.selectFirst("a.poster[href*=shplay.php], a.title[href*=shplay.php]") ?: return@mapNotNull null
            val id = ID_REGEX.find(a.attr("href"))?.groupValues?.get(1) ?: return@mapNotNull null
            if (!seen.add(id)) return@mapNotNull null
            val name = item.selectFirst("h3 a.title, a.title")?.text()?.trim()?.ifEmpty { null }
                ?: item.selectFirst("img")?.attr("alt")?.trim().orEmpty()
            if (name.isEmpty()) return@mapNotNull null
            val year = item.select(".meta > span").firstNotNullOfOrNull { YEAR_ONLY.find(it.text().trim())?.value }
            SAnime.create().apply {
                url = "/shplay.php?id=$id"
                title = if (movie && year != null && !TITLE_YEAR.containsMatchIn(name)) "$name ($year)" else name
                thumbnail_url = item.selectFirst("img")?.let { img -> img.absUrl("data-src").ifEmpty { img.absUrl("src") } }
                    ?.takeUnless { it.isEmpty() || it.startsWith("data:") }
            }
        }
        // 다음 쪽: 지금 쪽(li.active) 뒤에 쪽 번호나 "다음" 링크(10쪽마다 숫자 대신 나옴)가 있으면. 빈 쪽이면 끝(인기순은 4~5쪽까지만)
        val hasNext = animes.isNotEmpty() && doc.select("ul.pagination li.active ~ li a[href*=page=]")
            .any { a -> a.text().trim().let { t -> t == "다음" || t.toIntOrNull() != null } }
        return AnimesPage(animes, hasNext)
    }

    // ================= 작품 정보 =================
    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url

    override fun animeDetailsParse(response: Response): SAnime {
        val doc = response.asDoc()
        val info = doc.selectFirst("section.info") ?: doc
        val rawTitle = doc.selectFirst("h1.entry-title")?.text()?.trim().orEmpty()
        val genres = metaValue(info, "장르").orEmpty()
        val year = metaValue(info, "연도")?.let { YEAR_ANY.find(it)?.value }
        val seasons = seasonsOf(doc)
        val movie = isMovie(genres, seasons)
        val latest = buildEpisodes(seasons, "0", movie).maxOfOrNull { it.date_upload } ?: 0L
        val airing = isAiring(movie, latest, genres)
        return SAnime.create().apply {
            // 애니요미는 서재 제목을 갱신하지 않아 방영일은 제목 대신 설명 맨 위에. 끝났거나 모르는 작품만 (연도)
            title = if (!airing && year != null && rawTitle.isNotEmpty() && !TITLE_YEAR.containsMatchIn(rawTitle)) "$rawTitle ($year)" else rawTitle
            thumbnail_url = info.selectFirst(".poster img")?.let { img -> img.absUrl("data-src").ifEmpty { img.absUrl("src") } }
                ?.takeUnless { it.isEmpty() || it.startsWith("data:") }
            genre = genres.split(",").map { it.trim() }.filter { it.isNotEmpty() }.joinToString(", ").ifEmpty { null }
            author = metaValue(info, "감독")
            status = when {
                movie -> SAnime.COMPLETED
                airing -> SAnime.ONGOING
                latest > 0 -> SAnime.COMPLETED
                else -> SAnime.UNKNOWN
            }
            if (movie) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            val lines = mutableListOf<String>()
            if (latest > 0) {
                val d = synchronized(OUT_FMT) { OUT_FMT.format(java.util.Date(latest)) }
                lines.add("${if (airing) "방영 중" else "종영"} · 최근 방영: $d")
            } else if (airing) {
                lines.add("방영 중")
            }
            for (k in listOf("국가", "장르", "연도", "감독", "배우")) metaValue(info, k)?.let { lines.add("$k: $it") }
            info.selectFirst(".desc")?.text()?.trim()?.takeIf { it.isNotEmpty() }?.let { lines.add(it) }
            description = lines.joinToString("\n")
        }
    }

    private fun isMovie(genres: String, seasons: List<List<Ep>>): Boolean {
        val all = seasons.flatten()
        return genres.contains("영화") || (all.size == 1 && !EP_NUM_REGEX.containsMatchIn(all[0].label))
    }

    // 회차 이름에 방송 날짜가 있으면(가요무대 등) 최근 방영 3주 안이면 방영 중, 없으면 장르의 방송 요일로
    private fun isAiring(movie: Boolean, latest: Long, genres: String): Boolean = when {
        movie -> false
        latest > 0 -> System.currentTimeMillis() - latest <= 21L * 86_400_000L
        else -> AIRING_REGEX.containsMatchIn(genres)
    }

    /** "국가:", "장르:" 같은 항목 값 */
    private fun metaValue(root: Element, key: String): String? = root.select(".meta > div")
        .firstOrNull { it.selectFirst("span")?.text()?.contains(key) == true }
        ?.select("span")?.drop(1)?.joinToString(" ") { it.text().trim() }?.trim()?.ifEmpty { null }

    private class Ep(val label: String, val links: List<String>)

    /** manualSeasons: [{"e":[{"link_1":..., "host_1":"제1화", "link_2":...}, ...]}, ...] */
    private fun seasonsOf(doc: Document): List<List<Ep>> {
        val json = doc.select("script").firstNotNullOfOrNull { SEASONS_REGEX.find(it.data())?.groupValues?.get(1) }
            ?: return emptyList()
        return runCatching {
            val arr = JSONArray(json)
            (0 until arr.length()).map { s ->
                val eps = arr.optJSONObject(s)?.optJSONArray("e") ?: JSONArray()
                (0 until eps.length()).map { i ->
                    val o = eps.getJSONObject(i)
                    val links = (1..3).map { k -> o.optString("link_$k").trim() }.filter { it.startsWith("http") }
                    Ep(o.optString("host_1").replace(SPACES, " ").trim(), links)
                }
            }
        }.getOrDefault(emptyList())
    }

    // ================= 회차 =================
    // 영화 회차 이름은 "본편" 으로 통일 (MovieName)
    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val id = response.request.url.queryParameter("id") ?: return emptyList()
        val info = doc.selectFirst("section.info") ?: doc
        val seasons = seasonsOf(doc)
        return MovieName.unify(buildEpisodes(seasons, id, isMovie(metaValue(info, "장르").orEmpty(), seasons)))
    }

    /** 회차 이름이 날짜("26-10-19"·"2026-10-19"·"26.10.19")면 (한국 시간 그날 0시, "26.10.19") */
    private fun labelDate(label: String): Pair<Long, String>? {
        val m = LABEL_DATE.find(label) ?: return null
        val y = m.groupValues[1].let { if (it.length == 2) 2000 + it.toInt() else it.toInt() }
        val mo = m.groupValues[2].toInt()
        val d = m.groupValues[3].toInt()
        if (mo !in 1..12 || d !in 1..31) return null
        val cal = Calendar.getInstance(KST).apply {
            clear()
            set(y, mo - 1, d, 0, 0, 0)
        }
        return cal.timeInMillis to "%02d.%02d.%02d".format(y % 100, mo, d)
    }

    /**
     * 회차 (망가요미판과 같은 규칙). 사이트 순서가 작품마다 달라(최신이 위 / 1화가 위) 번호·날짜로 방향을 보고 최신이 위로.
     * 이름이 방송 날짜면 오래된 것부터 차례 번호 "N회 (yy.MM.dd)" + 날짜, 번호 없는 회차가 10개 넘게 이어지면 차례 번호,
     * 번호 없는 회차 몇 개는 앞 회차 번호 + 0.5. 회차 번호는 겹치지 않게. 여러 시즌이면 "시즌N " 을 앞에, 최신 시즌이 위
     */
    private fun buildEpisodes(seasons: List<List<Ep>>, id: String, movie: Boolean): List<SEpisode> {
        val multi = seasons.size > 1
        val bySeason = seasons.mapIndexed { s, eps ->
            val nums = eps.map { e -> EP_NUM_REGEX.find(e.label)?.groupValues?.get(1)?.toFloatOrNull() }
            val dates = eps.map { e -> labelDate(e.label) }
            val known = nums.filterNotNull()
            val dated = dates.filterNotNull()
            val byDate = known.isEmpty() && dated.isNotEmpty() && dated.size * 2 >= eps.size
            val newestFirst = if (byDate) {
                dated.size >= 2 && dated.first().first > dated.last().first
            } else {
                known.size >= 2 && known.first() > known.last()
            }
            val order = eps.indices.toList().let { if (newestFirst) it.reversed() else it }
            var run = 0
            var longRun = false
            for (i in order) {
                run = if (nums[i] == null) run + 1 else 0
                if (run > 9) longRun = true
            }
            val seqMode = byDate || (longRun && eps.size > 1)
            var last = 0f
            var step = 0
            val used = HashSet<Float>()
            val part = order.mapIndexed { k, i ->
                val e = eps[i]
                var no: Float
                val label: String
                when {
                    seqMode -> {
                        no = (k + 1).toFloat()
                        label = dates[i]?.let { "${k + 1}회 (${it.second})" } ?: "${k + 1}회 ${e.label}".trim()
                    }
                    nums[i] != null -> {
                        no = nums[i]!!
                        last = no
                        step = 0
                        val rest = e.label.replace(EP_PREFIX, "").trim()
                        label = "${fmt(no)}화${if (rest.isNotEmpty()) " $rest" else ""}"
                    }
                    eps.size == 1 && seasons.size == 1 -> {
                        no = 1f
                        label = if (movie) "본편" else e.label.ifEmpty { "본편" }
                    }
                    else -> {
                        step = minOf(step + 1, 9)
                        no = Math.round((last + 0.5f + (step - 1) / 10f) * 10f) / 10f
                        label = "${fmt(no)} ${e.label.replace(SPACES, "").ifEmpty { "특별편" }}"
                    }
                }
                while (!used.add(no)) no += 0.01f
                SEpisode.create().apply {
                    url = "/shplay.php?id=$id&ep=${s}_$i"
                    name = if (multi) "시즌${s + 1} $label" else label
                    // 여러 시즌이면 시즌마다 번호가 다시 시작해 겹치므로 시즌 번호를 1000 단위로 더함
                    episode_number = if (multi) (s + 1) * 1000f + no else no
                    date_upload = dates[i]?.first ?: 0L
                }
            }
            part.reversed()
        }
        // 최신 시즌이 위로
        return bySeason.reversed().flatten()
    }

    private fun fmt(n: Float): String = if (n == n.toInt().toFloat()) n.toInt().toString() else n.toString()

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val idNo = ID_REGEX.find(episode.url)?.groupValues?.get(1) ?: throw Exception("회차 주소가 이상해요: ${episode.url}")
        val (s, e) = EP_REGEX.find(episode.url)?.let { it.groupValues[1].toInt() to it.groupValues[2].toInt() } ?: (0 to 0)
        val doc = client.newCall(GET("$baseUrl/shplay.php?id=$idNo", h())).execute().use { res ->
            if (!res.isSuccessful) throw Exception("작품 화면을 열지 못했어요 (HTTP ${res.code})")
            Jsoup.parse(res.body.string(), res.request.url.toString())
        }
        val ep = seasonsOf(doc).getOrNull(s)?.getOrNull(e)
            ?: throw Exception("회차 정보를 찾지 못했어요. 회차 목록을 아래로 당겨 새로고침해 주세요")
        if (ep.links.isEmpty()) throw Exception("이 회차에는 재생 주소가 없어요")
        val siteRef = "$baseUrl/"
        val fails = mutableListOf<String>()
        // 영상 서버(wiselife.blog/hls/…)는 플레이어 화면 밖(재생기·확장)에서 온 목록 요청에 502 (2026-11-09 사용자 화면, 8761~8763)
        // → 숨은 웹뷰로 플레이어를 열고, 플레이어가 받은 목록 글자를 화면 안에서 함께 받아(capture) 앱 안 중계 주소(LocalProxy)로 재생기에 건넴(조각도 확장 통신으로 중계).
        // 암호를 풀거나 내용을 바꾸지 않음
        for ((i, link) in ep.links.withIndex()) {
            val origin = link.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" } ?: siteRef.trimEnd('/')
            val label = if (i == 0) LABEL else "$LABEL (대체 $i)"
            val cap = capture(link, siteRef)
            // 중계도 웹뷰와 같은 브라우저 이름으로
            val vh = Headers.Builder()
                .set("User-Agent", cap.ua ?: USER_AGENT)
                .set("Referer", "$origin/")
                .set("Origin", origin)
                .build()
            val media = cap.reports.lastOrNull { it.status in 200..299 && it.text.contains("#EXTINF") }
            if (media != null) {
                val url = LocalProxy.fromText(client, vh, media.text, media.url)
                return@withContext listOf(Video(url, label, url))
            }
            // 목록 글자를 못 받았어도 주소를 잡았으면 확장 통신으로 중계 (재생기 직접 접속은 502)
            cap.urls.firstOrNull { REAL_HLS.containsMatchIn(it) }?.takeIf { cap.reports.none { r -> r.url == it } }?.let { u ->
                val url = LocalProxy.playlist(client, vh, u)
                return@withContext listOf(Video(url, "$label (중계)", url))
            }
            val bad = cap.reports.firstOrNull { REAL_HLS.containsMatchIn(it.url) }
            fails.add(
                when {
                    bad != null -> "서버${i + 1} 웹뷰에서도 HTTP ${bad.status}"
                    cap.urls.isNotEmpty() -> "서버${i + 1} 목록 내용 못 받음 (주소 ${cap.urls.size}개${if (cap.hooked) "" else " · 엿보기 안 붙음"})"
                    else -> "서버${i + 1} 못 찾음${if (cap.hooked) "" else " (엿보기 안 붙음)"}"
                },
            )
        }
        throw Exception("영상을 못 불러왔어요 [${fails.joinToString(", ").take(160)}]")
    }

    private class Report(val url: String, val status: Int, val text: String)

    private class Capture(val urls: List<String>, val reports: List<Report>, val hooked: Boolean, val ua: String?)

    /**
     * 숨은 웹뷰로 플레이어 화면을 그대로 열고(브라우저 이름도 휴대폰 웹뷰 그대로 — 고정 이름·화면 끼워 넣기는 9243 에서 "웹뷰에서도 HTTP 0"),
     * 화면이 열리는 순간 작은 엿보기 코드를 넣어 플레이어가 받은 m3u8 의 결과(상태·글자)를 알려 받음.
     * 영상 목록(#EXTINF 있는 것)을 받으면 바로 끝, 아니면 최대 20초. 아무것도 막지 않음(망가요미판과 같게), 2·6·12초에 소리 끈 채 재생 눌러 봄
     */
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun capture(link: String, referer: String): Capture {
        val urls = Collections.synchronizedList(mutableListOf<String>())
        val reports = Collections.synchronizedList(mutableListOf<Report>())
        val done = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        var webViewRef: WebView? = null
        var hooked = false
        var webUa: String? = null
        val bridge = object {
            @JavascriptInterface
            fun report(url: String, status: Int, text: String) {
                reports.add(Report(url, status, text))
                if (status in 200..299 && text.contains("#EXTINF")) done.countDown()
            }

            @JavascriptInterface
            fun ready() {
                hooked = true
            }
        }
        handler.post {
            try {
                val context = Class.forName("android.app.ActivityThread")
                    .getMethod("currentApplication").invoke(null) as Application
                val webView = WebView(context)
                webViewRef = webView
                webView.settings.javaScriptEnabled = true
                webView.settings.domStorageEnabled = true
                webView.settings.mediaPlaybackRequiresUserGesture = false
                webUa = webView.settings.userAgentString
                webView.addJavascriptInterface(bridge, "MimiCap")
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                        view.evaluateJavascript(CAP_SCRIPT, null)
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        view.evaluateJavascript(CAP_SCRIPT, null)
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val reqUrl = request.url.toString()
                        val path = request.url.path?.lowercase().orEmpty()
                        if (path.endsWith(".m3u8")) urls.add(reqUrl)
                        // 그림·광고를 막지 않음 — 막으면 플레이어가 목록 전에 받는 요청까지 막혀 서버가 목록을 거절(9244 "웹뷰에서도 HTTP 500")
                        return super.shouldInterceptRequest(view, request)
                    }
                }
                webView.loadUrl(link, mapOf("Referer" to referer))
            } catch (e: Throwable) {
                done.countDown()
            }
        }
        val deadline = System.currentTimeMillis() + 20_000
        for (at in listOf(2L, 4L, 6L)) {
            if (done.await(at, TimeUnit.SECONDS)) break
            handler.post { runCatching { webViewRef?.evaluateJavascript(PLAY_SCRIPT, null) } }
        }
        val left = deadline - System.currentTimeMillis()
        if (left > 0) done.await(left, TimeUnit.MILLISECONDS)
        handler.post {
            runCatching {
                webViewRef?.stopLoading()
                webViewRef?.destroy()
            }
        }
        return Capture(synchronized(urls) { urls.toList() }, synchronized(reports) { reports.toList() }, hooked, webUa)
    }

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = ExtStatus.prepend("mimitv", baseUrl, autoDomain(), baseFilters())

    private fun baseFilters(): AnimeFilterList {
        fun text(i: IntArray) = listOfNotNull(
            CATEGORIES[i[0]].first,
            GENRES[i[1]].takeIf { i[1] > 0 },
            SORTS[i[2]].first,
        ).joinToString(" · ")
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("검색어가 없을 때만 적용 (작품·사이트 주소를 붙여 넣으면 바로 열기)"),
                CategoryFilter(),
                GenreFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class CategoryFilter : AnimeFilter.Select<String>("분류", CATEGORIES.map { it.first }.toTypedArray(), DEFAULT_LATEST[0])
    class GenreFilter : AnimeFilter.Select<String>("장르", GENRES.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "미미티비 주소 직접 지정 (선택)"
            summary = "비워 두면 자동으로 찾은 주소나 기본 주소($DEFAULT_BASE_URL)를 사용합니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "mimitv숫자.com 형식의 주소 (예: $DEFAULT_BASE_URL)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                var input = (newValue as String).trim().trimEnd('/')
                if (input.isNotEmpty() && !input.startsWith("http")) input = "https://$input"
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: $DEFAULT_BASE_URL)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "접속이 안 되면 주소 목록·평생 주소 안내 페이지·mimitv 번호 주소 중 열리는 주소로 자동 변경합니다."
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    private fun Response.asDoc(): Document = Jsoup.parse(body.string(), request.url.toString())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private val DISCOVER_LOCK = Any()
        private const val DEFAULT_BASE_URL = "https://mimitv13.com"

        // 사이트가 알려 주는 평생 주소 안내 페이지 (미미티비주소.com, 글에 mimitvN.com)
        private const val GUIDE_URL = "https://xn--hg3ba87o95e83l04o.com/"
        private const val SITE_MARKER = "shplay.php"
        private const val LABEL = "미미티비"
        private const val RATE_GAP_MS = 350L
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?mimitv\d+\.com$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?mimitv\d+\.com$""")
        private val PASTE_HOST_REGEX = Regex("""^(?:https?://)?(?:www\.)?(mimitv\d+\.com)(?:[/?#]|$)""", RegexOption.IGNORE_CASE)
        private val NUM_REGEX = Regex("""mimitv(\d+)\.com""")
        private const val PLAY_SCRIPT =
            "(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
                "var b=document.querySelector('.art-state,.art-control-play');if(b)b.click();})();"

        // 플레이어가 받은 m3u8 결과(상태·글자)를 확장에 알려 주는 엿보기 코드 (XHR·fetch 를 감싸기만 하고 동작은 그대로)
        private const val CAP_SCRIPT =
            "(function(){if(window.__mc)return;window.__mc=1;try{MimiCap.ready();}catch(e){}function rep(u,s,t){try{MimiCap.report(String(u),s|0,String(t||'').substring(0,3000000));}catch(e){}}" +
                "var o=XMLHttpRequest.prototype.open,sd=XMLHttpRequest.prototype.send;" +
                "XMLHttpRequest.prototype.open=function(m,u){this.__cu=u;return o.apply(this,arguments);};" +
                "XMLHttpRequest.prototype.send=function(){var x=this;x.addEventListener('loadend',function(){var u=x.responseURL||x.__cu||'';" +
                "if(/\\.m3u8/.test(u)){var t='';try{if(x.responseType===''||x.responseType==='text')t=x.responseText;}catch(e){}rep(u,x.status,t);}});" +
                "return sd.apply(this,arguments);};" +
                "if(window.fetch){var f=window.fetch;window.fetch=function(i){return f.apply(this,arguments).then(function(r){try{var u=r.url||(i&&i.url)||String(i);" +
                "if(/\\.m3u8/.test(u)){r.clone().text().then(function(t){rep(u,r.status,t);});}}catch(e){}return r;});};}})();"
        private val REAL_HLS = Regex("""/hls/[^?#]+\.m3u8""")
        private val ID_REGEX = Regex("""shplay\.php\?id=(\d+)""")
        private val EP_REGEX = Regex("""ep=(\d+)_(\d+)""")
        private val SEASONS_REGEX = Regex("""manualSeasons\s*=\s*(\[[\s\S]*?\])\s*;""")
        private val EP_NUM_REGEX = Regex("""(\d+(?:\.\d+)?)\s*화""")
        private val EP_PREFIX = Regex("""^제?\s*0*\d+(?:\.\d+)?\s*화\s*""")
        private val LABEL_DATE = Regex("""^\s*(\d{2}|\d{4})[-./](\d{1,2})[-./](\d{1,2})\s*$""")
        private val AIRING_REGEX = Regex("""월화|수목|금토|토일|일일|주말|매일|월요|화요|수요|목요|금요|토요|일요""")
        private val YEAR_ONLY = Regex("""^(?:19|20)\d{2}$""")
        private val YEAR_ANY = Regex("""(?:19|20)\d{2}""")
        private val TITLE_YEAR = Regex("""\((?:19|20)\d{2}\)\s*$""")
        private val SPACES = Regex("""\s+""")

        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val OUT_FMT = SimpleDateFormat("yyyy.MM.dd (E)", Locale.KOREA).apply { timeZone = KST }

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
        private val MOVIE_TIDS = setOf("1", "40", "41")

        /** 장르 (사이트 메뉴의 장르 목록, 0 = 전체) */
        private val GENRES = listOf(
            "전체", "스릴러", "액션", "범죄", "코미디", "로맨스", "공포", "미스터리", "다큐멘터리", "서사",
            "SF", "판타지", "가족", "전쟁", "모험", "웹드라마", "요리", "시상식", "버라이어티", "공연",
        )

        private val SORTS = listOf("최신순" to "", "인기순" to "vod_hits")

        // 기본: 인기 = 드라마 인기순, 최신 = 드라마 최신순 (망가요미판과 같음)
        private val DEFAULT_POPULAR = intArrayOf(4, 0, 1)
        private val DEFAULT_LATEST = intArrayOf(4, 0, 0)
    }
}
