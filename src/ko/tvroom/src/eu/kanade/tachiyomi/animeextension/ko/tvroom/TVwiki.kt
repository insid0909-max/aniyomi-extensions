package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.app.Application
import android.content.SharedPreferences
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
import eu.kanade.tachiyomi.animesource.model.Track
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.POST
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import rx.Observable
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * 티비위키 (tvwiki57.net, 2026-11-10 — 망가요미 tvwiki.js 1.0.13 과 같은 규칙).
 * 목록 /{분류}?sst={정렬}&page=N · /popular?page=N, 카드 .box, 검색 /search?stx=,
 * 작품 /{분류}/{번호} (회차 li[data-ep-idx]), 회차 /{분류}/{번호}/{회차번호}.
 * 재생: 회차 화면 iframe 의 data-session1 → /api/create_session.php → 플레이어 화면 →
 * (TVP_CONFIG 이면) 플레이어의 cast.php → cast-register 로 받은 재생 목록을 앱 안 중계(LocalProxy)로 재생기에 건넴
 * (망가요미판의 createHlsProxyUrl 과 같은 방식, 영상·열쇠 내용은 바꾸지 않음)
 */
class TVwiki : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "티비위키"
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
        get() = DomainGuard.pick(prefs(), PREF_DOMAIN_KEY, DEFAULT_BASE_URL, autoDomain(), { DOMAIN_REGEX.matches(it) })

    override val client: OkHttpClient = network.client.newBuilder()
        .apply { interceptors().add(0, FriendlyNet) }
        .addInterceptor(PageCache(SERIES_PATH))
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
        // 5xx·451·다른 사이트로 넘김만 주소 바뀜으로 봄 (Cloudflare 보안 확인 403 은 아님)
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

    private fun ua(): String = WebUa.value() ?: USER_AGENT

    /** 진짜 티비위키 첫 화면이면 그 host (넘겨 준 주소도 200 + 표시 글자 확인) */
    private fun realHost(host: String): String? = runCatching {
        val r = Request.Builder().url("https://$host/").header("User-Agent", ua()).build()
        plain.newCall(r).execute().use { res ->
            val fh = res.request.url.host
            val body = res.peekBody(600_000).string()
            if (HOST_REGEX.matches(fh) && res.code == 200 && body.contains("티비위키") && body.contains("class=\"box\"")) fh else null
        }
    }.getOrNull()

    @Volatile private var lastDiscover = 0L

    /** 저장소 주소 목록 → 안내 페이지(tvwiki.store)에 적힌 주소(큰 번호 3개) → 번호 +1~+3 (1분에 한 번) */
    private fun discoverDomain(currentHost: String): String? = synchronized(DISCOVER_LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now
        DomainList.host("tvwiki")?.takeIf { HOST_REGEX.matches(it) && it != currentHost }?.let { listed ->
            realHost(listed)?.let { return it }
        }
        val guided = runCatching {
            plain.newCall(Request.Builder().url(GUIDE_URL).header("User-Agent", ua()).build()).execute().use { r ->
                NUM_REGEX.findAll(r.body.string().lowercase()).mapNotNull { it.groupValues[1].toIntOrNull() }
                    .filter { it > 0 }.distinct().sortedDescending().take(3).toList()
            }
        }.getOrDefault(emptyList())
        for (g in guided) {
            val h = "tvwiki$g.net"
            if (h != currentHost) realHost(h)?.let { return it }
        }
        val n = NUM_REGEX.find(currentHost)?.groupValues?.get(1)?.toIntOrNull() ?: DomainGuard.hostNumber(DEFAULT_BASE_URL)
        for (i in 1..3) {
            val h = "tvwiki${n + i}.net"
            if (h != currentHost) realHost(h)?.let { return it }
        }
        null
    }

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", ua())
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 목록 =================
    private fun listUrl(idx: IntArray, page: Int): String {
        val cat = CATEGORIES[idx[0]].second
        if (cat == "popular") return "$baseUrl/popular?page=$page"
        return "$baseUrl/$cat?sst=${SORTS[idx[1]].second}&page=$page"
    }

    private fun ruleSizes() = intArrayOf(CATEGORIES.size, SORTS.size)

    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    // 사이트 주소(tvwikiN.net)를 붙여 넣으면 진짜 사이트인지 확인 후 직접 넣은 주소로 바로 적용 (작품 주소면 그 작품)
    // 검색 결과가 없으면 띄어쓰기 뺀 검색어 등으로 다시 찾음 (SearchSpacing)
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val pasted = PASTE_HOST_REGEX.find(query.trim())?.groupValues?.get(1)?.lowercase()
        if (pasted != null && page == 1) {
            return Observable.fromCallable { realHost(pasted) }.flatMap<AnimesPage> { real ->
                if (real != null) prefs()?.edit()?.putString(PREF_DOMAIN_KEY, "https://$real")?.apply()
                when {
                    seriesOf(query) != null -> super.fetchSearchAnime(page, query, filters)
                    real != null -> fetchPopularAnime(1)
                    else -> Observable.error<AnimesPage>(Exception("티비위키 주소가 아니거나 열리지 않아요: $pasted"))
                }
            }
        }
        return SearchSpacing.wrap(page, query) { q, p -> super.fetchSearchAnime(p, q, filters) }
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기 (주소 번호가 달라도 됨)
        seriesOf(query)?.let { return GET(baseUrl + it, h()) }
        val q = query.trim()
        if (q.isNotEmpty()) {
            val url = "$baseUrl/search".toHttpUrl().newBuilder()
                .addQueryParameter("stx", q)
                .addQueryParameter("page", page.toString())
                .build()
            return GET(url.toString(), h())
        }
        val idx = intArrayOf(
            filters.filterIsInstance<CategoryFilter>().firstOrNull()?.state ?: DEFAULT_LATEST[0],
            filters.filterIsInstance<SortFilter>().firstOrNull()?.state ?: 0,
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val path = response.request.url.encodedPath.trimEnd('/')
        if (SERIES_PATH.matches(path)) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { url = path }), false)
        }
        return parseList(response)
    }

    /** 주소 글자에서 작품 경로 "/분류/번호" (회차 주소면 회차 번호는 뺌) */
    private fun seriesOf(s: String): String? {
        val m = ITEM_URL.find(s.trim()) ?: return null
        return "/${m.groupValues[1]}/${m.groupValues[2]}"
    }

    /** 목록·검색 공통: 작품 카드 (.box). 다음 쪽은 쪽 번호 링크 중 가장 큰 번호가 지금보다 크면 */
    private fun parseList(response: Response): AnimesPage {
        val doc = response.asDoc()
        val page = response.request.url.queryParameter("page")?.toIntOrNull() ?: 1
        val seen = HashSet<String>()
        val animes = doc.select(".box").mapNotNull { box ->
            val a = box.selectFirst("a.img[href]") ?: return@mapNotNull null
            val path = seriesOf(a.attr("href")) ?: return@mapNotNull null
            if (!seen.add(path)) return@mapNotNull null
            val img = a.selectFirst("img")
            val title = box.selectFirst("a.title2")?.text()?.trim()?.ifEmpty { null }
                ?: box.selectFirst("a.title")?.text()?.trim()?.ifEmpty { null }
                ?: img?.attr("alt")?.trim().orEmpty()
            if (title.isEmpty() || title == NO_IMAGE_ALT) return@mapNotNull null
            SAnime.create().apply {
                url = path
                this.title = title
                thumbnail_url = img?.let { it.absUrl("data-src").ifEmpty { it.absUrl("src") } }
                    ?.takeUnless { it.isEmpty() || NO_IMG.containsMatchIn(it) }
            }
        }
        val maxPage = doc.select("a.pg_page[href]").maxOfOrNull { a ->
            PAGE_PARAM.find(a.attr("href"))?.groupValues?.get(1)?.toIntOrNull() ?: 0
        } ?: 0
        return AnimesPage(animes, animes.isNotEmpty() && maxPage > page)
    }

    // ================= 작품 정보 =================
    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url

    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun animeDetailsParse(response: Response): SAnime {
        val doc = response.asDoc()
        val path = response.request.url.encodedPath.trimEnd('/')
        val title = titleOf(doc)
        val movie = isMovieCat(path)
        val info = doc.select("dl.bo_v_info dd").map { it.text().trim() }.filter { it.isNotEmpty() }
        val year = info.firstOrNull { it.startsWith("개봉") }?.let { YEAR_ANY.find(it)?.value }
        val latest = registeredAt(doc)
        val airing = !movie && latest > 0 && System.currentTimeMillis() - latest <= 21L * 86_400_000L
        return SAnime.create().apply {
            // 애니요미는 서재 제목을 갱신하지 않아 방영일은 제목 대신 설명 맨 위에. 끝난 작품만 (연도)
            this.title = if (!airing && year != null && title.isNotEmpty() && !TITLE_YEAR.containsMatchIn(title)) "$title ($year)" else title
            thumbnail_url = (
                doc.selectFirst("#bo_v_poster img")?.absUrl("src")
                    ?: doc.select("img[src*=image.tmdb.org]").map { it.absUrl("src") }.firstOrNull { !it.contains("/w185/") }
                )?.takeUnless { it.isEmpty() || NO_IMG.containsMatchIn(it) }
            genre = CATEGORIES.firstOrNull { it.second == path.split('/').getOrNull(1) }?.first
            status = when {
                movie -> SAnime.COMPLETED
                airing -> SAnime.ONGOING
                latest > 0 -> SAnime.COMPLETED
                else -> SAnime.UNKNOWN
            }
            if (movie) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            val lines = mutableListOf<String>()
            if (latest > 0 && !movie) {
                val d = synchronized(OUT_FMT) { OUT_FMT.format(java.util.Date(latest)) }
                lines.add("${if (airing) "방영 중" else "종영"} · 최근 방영: $d")
            }
            lines.addAll(info)
            doc.selectFirst("#bo_v_movinfo .ori_title")?.text()?.trim()?.takeIf { it.isNotEmpty() }?.let { lines.add(it) }
            doc.selectFirst("li[data-ep-idx] p")?.text()?.trim()?.takeIf { it.isNotEmpty() }?.let { lines.add(it) }
            description = lines.joinToString("\n")
        }
    }

    private fun titleOf(doc: Document): String =
        doc.selectFirst(".bo_v_tit")?.text()?.replace(TITLE_TAIL, "")?.trim()?.ifEmpty { null }
            ?: doc.selectFirst("a.title.ep-link")?.text()?.replace(EP_TAIL, "")?.trim().orEmpty()

    private fun isMovieCat(path: String) = path.split('/').getOrNull(1) in MOVIE_CATS

    /** 화면 위 "등록된 날짜 : 2026.11.10" (지금 보이는 회차 = 가장 최근 회차의 날짜, 한국 시간 0시) */
    private fun registeredAt(doc: Document): Long {
        val t = doc.select("#bo_v_info li").map { it.text() }.firstOrNull { it.contains("등록") } ?: return 0L
        val m = DATE_REGEX.find(t) ?: return 0L
        val cal = Calendar.getInstance(KST).apply {
            clear()
            set(m.groupValues[1].toInt(), m.groupValues[2].toInt() - 1, m.groupValues[3].toInt(), 0, 0, 0)
        }
        return cal.timeInMillis
    }

    // ================= 회차 =================
    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    /**
     * 회차 (망가요미판과 같은 규칙): 이름에서 작품 제목을 빼고 "N화 (MM.dd)" 모양으로.
     * 번호가 없거나 겹치면 오래된 회차부터 겹치지 않는 번호를 줌. 사이트 순서는 최신이 위. 영화는 "본편" (MovieName)
     */
    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = response.asDoc()
        val title = titleOf(doc)
        val latest = registeredAt(doc)
        class Row(val path: String, val label: String, val on: Boolean)
        val seen = HashSet<String>()
        val rows = doc.select("li[data-ep-idx]").mapNotNull { li ->
            val a = li.selectFirst("a.title.ep-link") ?: return@mapNotNull null
            val m = ITEM_URL.find(a.attr("href")) ?: return@mapNotNull null
            val ep = m.groupValues[3].takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val path = "/${m.groupValues[1]}/${m.groupValues[2]}/$ep"
            if (!seen.add(path)) return@mapNotNull null
            var label = a.text().trim()
            if (title.isNotEmpty()) label = label.replace(title, "").trim()
            Row(path, label.ifEmpty { a.text().trim() }.replace(SPACES, " "), a.hasClass("on"))
        }
        // 오래된 회차부터 번호 매기기 (번호 없음·겹침이면 앞 번호 + 1, 그래도 겹치면 +0.01)
        val oldestFirst = rows.reversed()
        val nums = oldestFirst.map { r -> if (SPECIAL.containsMatchIn(r.label)) null else EP_NUM.find(r.label)?.groupValues?.get(1)?.toFloatOrNull() }
        val used = HashSet<Float>()
        var prev = 0f
        val eps = oldestFirst.mapIndexed { i, r ->
            var no = nums[i] ?: (prev + 1f)
            while (!used.add(no)) no = Math.round((no + 0.01f) * 100f) / 100f
            prev = no
            val date = if (r.on && latest > 0) latest else 0L
            val short = if (date > 0) synchronized(SHORT_FMT) { " (" + SHORT_FMT.format(java.util.Date(date)) + ")" } else ""
            SEpisode.create().apply {
                url = r.path
                // "826. 런닝맨 826화"·"6화" 처럼 들쭉날쭉한 이름을 "826화 (11.08)" 로 (망가요미판 formatEpisode 와 같음)
                name = if (nums[i] != null) "${fmt(nums[i]!!)}${EP_NUM.find(r.label)!!.groupValues[2]}$short" else "${fmt(no)}. ${r.label}"
                episode_number = no
                date_upload = date
            }
        }.reversed()
        return MovieName.unify(eps)
    }

    private fun fmt(n: Float): String = if (n == n.toInt().toFloat()) n.toInt().toString() else n.toString()

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val m = ITEM_URL.find(episode.url) ?: throw Exception("회차 주소가 이상해요: ${episode.url}")
        val site = baseUrl
        val pageUrl = "$site/${m.groupValues[1]}/${m.groupValues[2]}/${m.groupValues[3]}"
        val doc = client.newCall(GET(pageUrl, h())).execute().use { res ->
            if (!res.isSuccessful) throw Exception("회차 화면을 열지 못했어요 (HTTP ${res.code})")
            Jsoup.parse(res.body.string(), res.request.url.toString())
        }
        val sessions = doc.select("iframe[data-session1]").map { it.attr("data-session1") }
            .filter { it.isNotBlank() }.distinct().take(3)
        if (sessions.isEmpty()) throw Exception("재생 정보를 찾지 못했어요. 웹뷰에서 회차 화면을 확인해 주세요")
        val out = mutableListOf<Video>()
        val fails = mutableListOf<String>()
        for ((i, s) in sessions.withIndex()) {
            val label = if (i == 0) LABEL else "$LABEL (대체 $i)"
            runCatching { out.addAll(videosOf(site, pageUrl, s, label)) }
                .onFailure { fails.add("서버${i + 1} ${it.message.orEmpty().take(60)}") }
        }
        if (out.isEmpty()) throw Exception("영상을 못 불러왔어요 [${fails.joinToString(", ").take(180)}]")
        HlsQuality.sort(prefs(), out.distinctBy { it.url })
    }

    private fun videosOf(site: String, pageUrl: String, session: String, label: String): List<Video> {
        val sess = runCatching { JSONObject(session) }.getOrNull()
            ?.takeIf { it.optString("idx").isNotEmpty() } ?: throw Exception("재생 정보 읽기 실패")
        val subs = sess.optString("vtt").takeIf { it.startsWith("http") }?.let { listOf(Track(it, "자막")) } ?: emptyList()
        val sh = Headers.Builder()
            .set("User-Agent", ua())
            .set("Referer", pageUrl)
            .set("Origin", site)
            .set("Accept", "application/json")
            .build()
        val cs = client.newCall(POST("$site/api/create_session.php", sh, session.toRequestBody(JSON))).execute().use { r ->
            if (r.code != 200) throw Exception("재생 세션 HTTP ${r.code}")
            runCatching { JSONObject(r.body.string()) }.getOrNull() ?: throw Exception("재생 세션 응답 읽기 실패")
        }
        val player = cs.optString("player_url")
        if (!cs.optBoolean("success") || !player.startsWith("https://")) throw Exception("재생 세션 실패")
        val playerUrl = player.toHttpUrl().newBuilder()
            .addQueryParameter("t", cs.opt("t")?.toString().orEmpty())
            .addQueryParameter("sig", cs.optString("sig"))
            .build().toString()
        val ph = Headers.Builder().set("User-Agent", ua()).set("Referer", "$site/").set("Origin", site).build()
        val body = client.newCall(GET(playerUrl, ph)).execute().use { r ->
            if (r.code != 200) throw Exception("플레이어 HTTP ${r.code}")
            r.body.string()
        }
        val playerOrigin = playerUrl.toHttpUrl().let { "${it.scheme}://${it.host}" }
        TVP_CONFIG.find(body)?.let { cfg -> return listOf(castVideo(cfg.groupValues[1], playerOrigin, label, subs)) }
        val url = findM3u8(body) ?: throw Exception("영상 주소(m3u8)를 찾지 못함")
        val vh = Headers.Builder()
            .set("User-Agent", ua())
            .set("Referer", playerUrl)
            .set("Origin", playerOrigin)
            .set("Accept", "*/*")
            .build()
        val list = HlsQuality.expandIfWorks(client, url, label, vh) ?: listOf(Video(url, label, url, vh))
        return list.map { Video(it.url, it.quality, it.videoUrl, vh, subs) }
    }

    /** 플레이어 설정(TVP_CONFIG)으로 플레이어가 하는 그대로 재생권(cast.php → cast-register)을 받아 재생 목록 주소를 만듦 */
    private fun castVideo(config: String, playerOrigin: String, label: String, subs: List<Track>): Video {
        val c = runCatching { JSONObject(config) }.getOrNull() ?: throw Exception("플레이어 설정 읽기 실패")
        val host = c.optString("host")
        val contentId = c.optString("contentId")
        val pathType = c.optString("pathType")
        // 영상 서버는 poorcdn.com 의 어느 서버든(every10 등, 2026-11-10 리처만 안 되던 것), 경로 종류는 한 글자, 영상 번호는 16~64자
        if (c.optString("id").isEmpty() || !PATH_TYPE.matches(pathType) || !CAST_HOST.matches(host) || !CONTENT_ID.matches(contentId)) {
            throw Exception("지원하지 않는 재생 설정 [경로 ${pathType.take(8).ifEmpty { "-" }} · 서버 ${host.take(40).ifEmpty { "-" }} · 번호 ${contentId.length}자]")
        }
        val a = Headers.Builder()
            .set("User-Agent", ua())
            .set("Referer", "$playerOrigin/")
            .set("Origin", playerOrigin)
            .set("Accept", "*/*")
            .build()

        fun post(url: String, payload: JSONObject, extra: Headers.Builder.() -> Unit = {}): JSONObject {
            val hs = a.newBuilder().apply(extra).build()
            return client.newCall(POST(url, hs, payload.toString().toRequestBody(JSON))).execute().use { r ->
                if (r.code != 200) {
                    // 거절 이유(응답 앞부분)와 플레이어 설정 칸 이름을 보여 줌 (2026-11-10 리처 422)
                    val why = runCatching { r.body.string() }.getOrDefault("").replace(SPACES, " ").take(140)
                    throw Exception("재생권 HTTP ${r.code} [${url.substringAfter("://").substringAfter('/')} · 응답 $why · 설정 칸 ${c.keys().asSequence().joinToString(",").take(120)}]")
                }
                runCatching { JSONObject(r.body.string()) }.getOrNull() ?: throw Exception("재생권 응답 읽기 실패")
            }
        }
        val origin = "https://$host"
        val o = try {
            post("$playerOrigin/player/api/cast.php", JSONObject().put("id", c.optString("id"))) { set("X-Player-Cast", "1") }
        } catch (e: Exception) {
            // 재생권(cast)을 쓰지 않는 영상(리처 등, 2026-11-10 "cast_source_unsupported"): 설정의 src 가 일반 주소면 그 주소로 바로 재생
            if (e.message?.contains("cast_source_unsupported") != true) throw e
            val src = c.optString("src").trim()
            val u = when {
                src.startsWith("http://") || src.startsWith("https://") -> src
                src.startsWith("/") && !src.startsWith("//") -> origin + src
                else -> ""
            }
            if (u.isEmpty()) {
                val tail = if (src.length > 24) "…" else ""
                throw Exception("다른 재생 방식이라 아직 지원 안 함 [mode ${c.optString("mode").take(20).ifEmpty { "-" }} · src ${src.take(24)}$tail (${src.length}자)]")
            }
            if (MP4.containsMatchIn(u)) return Video(u, "$label 원본 (mp4)", u, a, subs)
            val proxied = LocalProxy.playlist(client, a, u)
            return Video(proxied, "$label 자동 (HLS)", proxied, null, subs)
        }
        val grant = o.optString("grant")
        if (o.optInt("version") != 1 || o.optString("contentId") != contentId || o.optString("origin") != origin ||
            o.optString("registerUrl") != "$origin/v/cast-register" || !grant.startsWith("r1.") || grant.length > 384
        ) {
            throw Exception("올바른 재생권이 아님")
        }
        val l = post(o.optString("registerUrl"), JSONObject().put("cast_grant", grant))
        val token = l.optString("token")
        if (!l.optBoolean("ok") || l.optString("contentId") != contentId || !TOKEN.matches(token) || token.length > 384) {
            throw Exception("재생권 등록 실패")
        }
        val list = "$origin/v/$pathType/$contentId/c.html".toHttpUrl().newBuilder().addQueryParameter("cast", token).build().toString()
        // 재생 목록 주소가 .m3u8 로 끝나지 않고 재생기는 머리글을 조각마다 못 붙이므로 앱 안 중계로 (망가요미 createHlsProxyUrl 과 같음)
        val proxied = LocalProxy.playlist(client, a, list)
        return Video(proxied, "$label 자동 (HLS)", proxied, null, subs)
    }

    private fun findM3u8(body: String): String? {
        val b = body.replace("&amp;", "&").replace("\\/", "/")
        return listOf(DATA_M3U8, ANY_M3U8, SOURCE_M3U8, FILE_M3U8).firstNotNullOfOrNull { r ->
            r.find(b)?.let { it.groups[1]?.value ?: it.value }
        }?.takeIf { it.startsWith("http") }
    }

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = ExtStatus.prepend("tvwiki", baseUrl, autoDomain(), baseFilters())

    private fun baseFilters(): AnimeFilterList {
        fun text(i: IntArray) = if (CATEGORIES[i[0]].second == "popular") {
            CATEGORIES[i[0]].first
        } else {
            "${CATEGORIES[i[0]].first} · ${SORTS[i[1]].first}"
        }
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("검색어가 없을 때만 적용 (작품·사이트 주소를 붙여 넣으면 바로 열기)"),
                CategoryFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class CategoryFilter : AnimeFilter.Select<String>("분류", CATEGORIES.map { it.first }.toTypedArray(), DEFAULT_LATEST[0])
    class SortFilter : AnimeFilter.Select<String>("정렬 (인기 분류엔 적용 안 됨)", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "티비위키 주소 직접 지정 (선택)"
            summary = "비워 두면 자동으로 찾은 주소나 기본 주소($DEFAULT_BASE_URL)를 사용합니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "tvwiki숫자.net 형식의 주소 (예: $DEFAULT_BASE_URL)"
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
            summary = "접속이 안 되면 주소 목록·안내 페이지(tvwiki.store)·tvwiki 번호 주소 중 열리는 주소로 자동 변경합니다."
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    private fun Response.asDoc(): Document = Jsoup.parse(body.string(), request.url.toString())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private val DISCOVER_LOCK = Any()
        private const val DEFAULT_BASE_URL = "https://tvwiki57.net"
        private const val GUIDE_URL = "https://tvwiki.store/"
        private const val LABEL = "티비위키"
        private const val RATE_GAP_MS = 350L
        private const val NO_IMAGE_ALT = "이미지가 없습니다."
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"
        private val JSON = "application/json".toMediaType()

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?tvwiki\d+\.net$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?tvwiki\d+\.net$""")
        private val PASTE_HOST_REGEX = Regex("""^(?:https?://)?(?:www\.)?(tvwiki\d+\.net)(?:[/?#]|$)""", RegexOption.IGNORE_CASE)
        private val NUM_REGEX = Regex("""tvwiki(\d+)\.net""")
        private val SERIES_PATH = Regex("""^/[a-z_]+/\d+$""")
        private val ITEM_URL = Regex("""(?:^|tvwiki\d+\.net)/([a-z_]+)/(\d+)(?:/(\d+))?/?(?:[?#]|$)""")
        private val PAGE_PARAM = Regex("""[?&](?:amp;)?page=(\d+)""")
        private val NO_IMG = Regex("""/img/no\d*\.png$""")
        private val TITLE_TAIL = Regex("""\s*(?:\d+(?:\.\d+)?\s*[화회])?\s*다시보기\s*$""")
        private val EP_TAIL = Regex("""\s*\d+(?:\.\d+)?\s*[화회]\s*$""")
        private val EP_NUM = Regex("""(?:제\s*)?(\d+(?:\.\d+)?)\s*(화|회)""")
        private val SPECIAL = Regex("""특집|특별편|예고|외전|미방영|\b(?:OVA|SP\d*|SPECIAL)\b""", RegexOption.IGNORE_CASE)
        private val DATE_REGEX = Regex("""(20\d{2})[-./](\d{1,2})[-./](\d{1,2})""")
        private val YEAR_ANY = Regex("""(?:19|20)\d{2}""")
        private val SPACES = Regex("""\s+""")
        private val TITLE_YEAR = Regex("""\((?:19|20)\d{2}\)\s*$""")
        private val TVP_CONFIG = Regex("""window\.TVP_CONFIG\s*=\s*(\{[^\n]*?\})\s*;""")
        private val CAST_HOST = Regex("""^[a-z0-9-]+\.poorcdn\.com$""")
        private val PATH_TYPE = Regex("""^[a-z]$""")
        private val MP4 = Regex("""\.mp4(?:[?#]|$)""", RegexOption.IGNORE_CASE)
        private val CONTENT_ID = Regex("""^[A-Za-z0-9_-]{16,64}$""")
        private val TOKEN = Regex("""^p1\.[A-Za-z0-9_.-]+$""")
        private val DATA_M3U8 = Regex("""data-m3u8=["'](https?://[^"']+)["']""", RegexOption.IGNORE_CASE)
        private val ANY_M3U8 = Regex("""https?://[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*""", RegexOption.IGNORE_CASE)
        private val SOURCE_M3U8 = Regex(
            """<source[^>]*type=["']application/(?:x-mpegurl|vnd\.apple\.mpegurl)["'][^>]*src=["']([^"']+)["']""",
            RegexOption.IGNORE_CASE,
        )
        private val FILE_M3U8 = Regex(
            """["']?(?:file|src|source|url)["']?\s*[:=]\s*["'](https?://[^"']*(?:hls|m3u8|stream|video)[^"']*)["']""",
            RegexOption.IGNORE_CASE,
        )

        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val OUT_FMT = SimpleDateFormat("yyyy.MM.dd (E)", Locale.KOREA).apply { timeZone = KST }
        private val SHORT_FMT = SimpleDateFormat("MM.dd", Locale.KOREA).apply { timeZone = KST }

        /** 분류 이름 → 주소 (popular = 사이트 인기 목록) */
        private val CATEGORIES = listOf(
            "인기" to "popular",
            "드라마" to "drama",
            "예능" to "ent",
            "영화" to "movie",
            "한국영화" to "kor_movie",
            "해외드라마" to "world",
            "해외(예능/다큐)" to "ott_ent",
            "[극장판] 애니메이션" to "ani_movie",
            "일반 애니메이션" to "animation",
            "시사/다큐" to "sisa",
            "숏폼 드라마" to "short_drama",
            "추억의 드라마" to "old_drama",
            "추억의 예능" to "old_ent",
        )
        private val MOVIE_CATS = setOf("movie", "kor_movie", "ani_movie")

        private val SORTS = listOf(
            "최근 방영순" to "subidx",
            "최근 등록순" to "wr_datetime",
            "조회수 높은순" to "wr_hit",
            "좋아요 높은순" to "wr_good",
        )

        // 기본: 인기 = 사이트 인기 목록, 최신 = 드라마 최근 방영순 (망가요미판과 같음)
        private val DEFAULT_POPULAR = intArrayOf(0, 0)
        private val DEFAULT_LATEST = intArrayOf(1, 0)
    }
}
