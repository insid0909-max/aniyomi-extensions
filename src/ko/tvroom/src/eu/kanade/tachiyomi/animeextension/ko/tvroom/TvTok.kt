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
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import rx.Observable
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * 티비톡 (tvtok11.com, 2026-11-22) — 미미티비가 이름을 바꾼 새 사이트 (평생 주소 미미티비주소.com → xlqlxhr.com → tvtok11.com).
 * 망가요미판 tvtok.js 0.1.0 과 같은 규칙. 모두 JSON:
 *   목록 /api/browse/{분류}?genre=&sort=(빈|popular|rating)&page=N&size=42 → {total, items[{id,type,title,thumb}]}
 *     (분류 top10 = 전체 작품 25,093개, 장르 거르기는 자료가 0개라 안 넣음)
 *   검색 /api/search?q= → {items}
 *   작품 /api/watch/{분류}/{번호} → {title, thumb, genre, updated, year, episodes[{id,n,title,date}]}
 *     (회차 차례가 작품마다 다름 → 번호로 방향을 봐 최신이 위, 날짜 없는 작품 많음)
 *   영상 /api/playlist/{회차 id}/index.m3u8 (조각 res.tvwow1.com/….ts, 웹뷰·암호 없음)
 */
class TvTok : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "티비톡"
    override val lang = "ko"
    override val supportsLatest = true

    // ================= 주소와 설정 =================
    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    private fun autoDomain(): Boolean = prefs()?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

    // 직접 넣은 주소 > 자동으로 찾은 주소 > 기본 주소
    override val baseUrl: String
        get() = DomainGuard.pick(prefs(), PREF_DOMAIN_KEY, DEFAULT_BASE_URL, autoDomain(), { DOMAIN_REGEX.matches(it) }).also { cur ->
            // 6시간마다 저장소 주소 목록에 더 큰 번호 주소가 있고 진짜 사이트면 그 주소로 (뒤에서)
            DomainList.followLater("tvtok", prefs(), PREF_DOMAIN_KEY, cur, autoDomain()) { h -> HOST_REGEX.matches(h) && isSite(h) }
        }

    override val client: OkHttpClient = network.client.newBuilder()
        .apply { interceptors().add(0, FriendlyNet) }
        .addInterceptor(PageCache(Regex("^/api/watch/")))
        // 포스터는 다른 서버(res.tvwow1.com·img.pongping.top)라 간격 제한에 걸리지 않음
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS, skipImages = true))
        .addInterceptor { chain -> domainIntercept(chain) }
        .addInterceptor(RetryOnce(HOST_REGEX))
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", USER_AGENT)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().set("Accept", "application/json").build()

    // ================= 주소 자동 찾기 (연결 실패·5xx·451 일 때만, 403 보안 확인은 주소 바뀜 아님) =================
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
        if (req.method == "GET" && (res.code == 451 || res.code >= 500)) {
            val found = discoverDomain(baseHost) ?: return res
            res.close()
            return retryOn(found)
        }
        // 사이트가 스스로 새 주소로 넘겨 준 경우(200 일 때만) 그 주소를 저장
        val finalHost = res.request.url.host
        if (res.code == 200 && finalHost != baseHost && HOST_REGEX.matches(finalHost)) {
            DomainGuard.saveAuto(prefs(), PREF_DOMAIN_KEY, "https://$finalHost")
        }
        return res
    }

    private val plain by lazy {
        network.client.newBuilder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .callTimeout(12, TimeUnit.SECONDS)
            .build()
    }

    /** 진짜 티비톡이면 true (/api/home 이 top10 을 줌) */
    private fun isSite(host: String): Boolean = runCatching {
        val r = Request.Builder().url("https://$host/api/home").header("User-Agent", USER_AGENT).build()
        plain.newCall(r).execute().use { res ->
            res.code == 200 && res.request.url.host == host && res.peekBody(400_000).string().contains("\"top10\"")
        }
    }.getOrDefault(false)

    /** 그 주소가 넘겨 주는 마지막 주소의 host (OkHttp 가 따라감) */
    private fun movedHost(url: String): String? = runCatching {
        plain.newCall(Request.Builder().url(url).header("User-Agent", USER_AGENT).build()).execute().use { res ->
            res.request.url.host.lowercase().removePrefix("www.").takeIf { HOST_REGEX.matches(it) }
        }
    }.getOrNull()

    @Volatile private var lastDiscover = 0L

    /** 저장소 주소 목록 → 안내 채널(t.me/s/tvtok_url) 큰 번호 3개 → 평생 주소·지금 주소가 넘겨 주는 곳 → 번호 +1~+3 (1분에 한 번) */
    private fun discoverDomain(currentHost: String): String? = synchronized(DISCOVER_LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now
        val cur = DomainGuard.hostNumber(currentHost)
        val tries = LinkedHashSet<String>()
        DomainList.host("tvtok")?.let { tries.add(it.lowercase().removePrefix("www.")) }
        runCatching {
            plain.newCall(Request.Builder().url(GUIDE_URL).header("User-Agent", USER_AGENT).build()).execute().use { r ->
                GUIDE_HOST.findAll(r.body.string()).map { it.value.lowercase() }.distinct()
                    .sortedByDescending { DomainGuard.hostNumber(it) }.take(3).forEach { tries.add(it) }
            }
        }
        movedHost(LIFETIME_URL)?.let { tries.add(it) }
        movedHost("https://$currentHost/")?.let { tries.add(it) }
        for (i in 1..3) tries.add("tvtok${cur + i}.com")
        for (t in tries) {
            if (t == currentHost || !HOST_REGEX.matches(t) || DomainGuard.hostNumber(t) < cur) continue
            if (isSite(t)) return t
        }
        null
    }

    // ================= 목록 =================
    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    /** idx = [분류, 정렬] */
    private fun listUrl(idx: IntArray, page: Int): String =
        "$baseUrl/api/browse/${LISTS[idx[0]].second}?genre=&sort=${SORTS[idx[1]].second}&page=$page&size=$PAGE_SIZE"

    private fun ruleSizes() = intArrayOf(LISTS.size, SORTS.size)

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
        // 사이트 주소만 붙여 넣으면 확인 후 그 주소를 씀, 작품 주소면 그 작품을 바로 열기
        PASTE_HOST.find(q)?.let { m ->
            val host = m.groupValues[1].lowercase().removePrefix("www.")
            if ("https://$host" != baseUrl && isSite(host)) DomainGuard.saveAuto(prefs(), PREF_DOMAIN_KEY, "https://$host")
            val w = WATCH_PATH.find(q)
            return if (w != null) {
                GET("$baseUrl/api/watch/${w.groupValues[1]}/${w.groupValues[2]}", h())
            } else {
                popularAnimeRequest(1)
            }
        }
        if (q.isNotEmpty()) return GET("$baseUrl/api/search?q=${enc(q)}&page=$page", h())
        fun sel(f: AnimeFilter.Select<*>?) = f?.state ?: 0
        val idx = intArrayOf(
            sel(filters.filterIsInstance<ListFilter>().firstOrNull()),
            sel(filters.filterIsInstance<SortFilter>().firstOrNull()),
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val path = response.request.url.encodedPath
        if (path.startsWith("/api/watch/")) {
            val o = json(response, "작품")
            val card = card(o) ?: return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(card), false)
        }
        // 검색은 사이트가 한 쪽에 다 줌 → 2쪽부터는 빈 목록
        if (path.startsWith("/api/search")) {
            if ((response.request.url.queryParameter("page")?.toIntOrNull() ?: 1) > 1) {
                response.close()
                return AnimesPage(emptyList(), false)
            }
            val items = json(response, "검색").optJSONArray("items") ?: JSONArray()
            return AnimesPage((0 until items.length()).mapNotNull { card(items.optJSONObject(it)) }, false)
        }
        return parseList(response)
    }

    private fun json(response: Response, step: String): JSONObject {
        response.use { res ->
            val body = res.body.string()
            val o = if (res.isSuccessful) runCatching { JSONObject(body) }.getOrNull() else null
            if (o == null) {
                val where = res.request.url.let { it.host + it.encodedPath.take(40) }
                throw Exception(
                    "티비톡 자료를 받지 못했어요. 주소가 바뀌었으면 검색창에 새 주소를 붙여 넣어 주세요. " +
                        "[$step · HTTP ${res.code} · $where · ${body.replace(Regex("\\s+"), " ").take(50)}]",
                )
            }
            return o
        }
    }

    private fun JSONObject.str(k: String): String = if (isNull(k)) "" else optString(k).trim()

    private fun card(o: JSONObject?): SAnime? {
        o ?: return null
        val t = o.str("title")
        val id = o.str("id")
        val type = o.str("type")
        if (t.isEmpty() || id.isEmpty() || type.isEmpty()) return null
        return SAnime.create().apply {
            url = "/watch/$type/$id"
            title = t
            thumbnail_url = o.str("thumb").ifEmpty { null }
        }
    }

    private fun parseList(response: Response): AnimesPage {
        val page = response.request.url.queryParameter("page")?.toIntOrNull() ?: 1
        val o = json(response, "목록")
        val items = o.optJSONArray("items") ?: JSONArray()
        val list = (0 until items.length()).mapNotNull { card(items.optJSONObject(it)) }
        return AnimesPage(list, list.isNotEmpty() && page * PAGE_SIZE < o.optInt("total", 0))
    }

    // ================= 작품 정보 =================
    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + "/api" + anime.url, h())

    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url

    private fun dayMs(s: String): Long {
        val m = DATE_RE.find(s) ?: return 0L
        return runCatching { DAY_FMT.get()!!.parse("${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]}")!!.time }.getOrDefault(0L)
    }

    private fun isMovieType(type: String) = type == "movie" || type == "kor_movie"

    override fun animeDetailsParse(response: Response): SAnime {
        val type = response.request.url.pathSegments.getOrNull(2).orEmpty()
        val o = json(response, "작품")
        val t = o.str("title")
        val eps = o.optJSONArray("episodes") ?: JSONArray()
        var newest = 0L
        for (i in 0 until eps.length()) newest = maxOf(newest, dayMs(eps.optJSONObject(i)?.str("date").orEmpty()))
        val updated = dayMs(o.str("updated")).takeIf { it > 0 } ?: newest
        val movie = isMovieType(type)
        val ongoing = !movie && updated > 0 && System.currentTimeMillis() - updated < 21 * 86_400_000L
        val year = o.optInt("year", 0).takeIf { it > 0 } ?: if (updated > 0) YEAR_FMT.get()!!.format(updated).toInt() else 0
        return SAnime.create().apply {
            // 애니요미는 서재 제목을 갱신하지 않음 → 바뀌는 방영일은 설명 맨 위에, 끝난 작품만 (연도)
            title = if (!ongoing && year > 0 && !YEAR_IN_TITLE.containsMatchIn(t)) "$t ($year)" else t
            thumbnail_url = o.str("thumb").ifEmpty { null }
            genre = o.str("genre").split('/').map { it.trim() }.filter { it.isNotEmpty() }.joinToString(", ").ifEmpty { null }
            status = when {
                movie -> SAnime.COMPLETED
                ongoing -> SAnime.ONGOING
                updated > 0 -> SAnime.COMPLETED
                else -> SAnime.UNKNOWN
            }
            if (movie) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            description = listOfNotNull(
                if (ongoing) "방영 중 · 최근 방영: ${FULL_FMT.get()!!.format(updated)}" else null,
                o.str("synopsis").ifEmpty { null },
                "분류: ${LISTS.firstOrNull { it.second == type }?.first ?: type}",
            ).joinToString("\n\n")
        }
    }

    // ================= 회차 =================
    override fun episodeListRequest(anime: SAnime): Request = animeDetailsRequest(anime)

    override fun episodeListParse(response: Response): List<SEpisode> {
        val path = response.request.url.encodedPath.removePrefix("/api")
        val type = response.request.url.pathSegments.getOrNull(2).orEmpty()
        val o = json(response, "회차")
        val title = o.str("title")
        val arr = o.optJSONArray("episodes") ?: JSONArray()
        fun bare(s: String) = s.replace(title, "").trim().trimStart(':', '·', '-', '–', ' ').trim()
        val items = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.filter { it.str("id").isNotEmpty() }
            .distinctBy { it.str("id") }
            .mapIndexed { i, e -> Triple(e, i, epParse(bare(e.str("title")).ifEmpty { e.str("title") })) }
            .toMutableList()
        // 회차 차례가 작품마다 다름(신병4 는 최신이 위, 옛 드라마는 1화가 위, 메이드 인 코리아 2 는 6·4·3·2·1·05 로 섞임)
        // → 모두 번호가 있으면 번호 큰 순서로, 번호 없는 회차가 섞이면 방향만 맞춤 (망가요미 0.1.1 과 같게)
        val numbered = items.filter { it.third.num != null }
        if (numbered.size == items.size && items.size >= 2) {
            items.sortWith(compareByDescending<Triple<JSONObject, Int, Ep>> { it.third.num!! }.thenBy { it.second })
        } else if (numbered.size >= 2 && numbered.first().third.num!! < numbered.last().third.num!!) {
            items.reverse()
        }
        val used = HashSet<Float>()
        val list = items.mapIndexed { i, (e, _, p) ->
            val ms = dayMs(e.str("date")).takeIf { it > 0 } ?: p.ms
            val date = if (ms > 0) " (${MMDD_FMT.get()!!.format(ms)})" else ""
            var num = p.num ?: (items.size - i).toFloat()
            while (!used.add(num)) num += 0.01f
            SEpisode.create().apply {
                url = "$path?ep=${e.str("id")}"
                name = p.name + date
                episode_number = num
                if (ms > 0) date_upload = ms
            }
        }
        if (isMovieType(type) && list.size == 1) list[0].name = "본편"
        return MovieName.unify(list)
    }

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val ep = EP_PARAM.find(episode.url)?.groupValues?.get(1)
            ?: throw Exception("회차 정보가 없어요. 회차 목록을 아래로 당겨 새로고침해 주세요")
        val main = "$baseUrl/api/playlist/$ep/index.m3u8"
        val vh = Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", "$baseUrl/")
            .set("Origin", baseUrl)
            .build()
        val list = HlsQuality.expandIfWorks(client, main, LABEL, vh)
            ?: throw Exception("영상 주소를 열지 못했어요 [회차 $ep · ${baseUrl.substringAfter("://")}/api/playlist]")
        HlsQuality.sort(prefs(), list.map { Video(it.url, it.quality, it.videoUrl, vh) })
    }

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    // 맨 위에 최근 업데이트 내역(📝)
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("tvtok", baseFilters())

    private fun baseFilters(): AnimeFilterList {
        fun text(i: IntArray): String = "${LISTS[i[0]].first} · ${SORTS[i[1]].first}"
        val note = DomainList.note("tvtok")?.let { " · 🔎 $it" }.orEmpty()
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}$note"),
                AnimeFilter.Header("🔗 미미티비가 이름을 바꾼 새 사이트 (같은 운영)"),
                AnimeFilter.Separator(),
                AnimeFilter.Header("검색어가 없을 때만 적용 (사이트·작품 주소를 붙여 넣으면 바로 열기)"),
                ListFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class ListFilter : AnimeFilter.Select<String>("분류", LISTS.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "티비톡 주소 직접 지정 (선택)"
            summary = "비워 두면 기본 주소($DEFAULT_BASE_URL) 또는 자동으로 찾은 주소를 씁니다"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 티비톡 주소 (예: https://tvtok11.com)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://tvtok11.com)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "주소 자동 찾기"
            summary = "접속이 안 되면 저장소 주소 목록·안내 채널·평생 주소(미미티비주소.com)에서 새 주소를 찾습니다"
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    private class Ep(val num: Float?, val name: String, val ms: Long)

    /**
     * 회차 이름 읽기 (작품 288개 회차 모양 점검, 망가요미 epParse 와 같음): "제01회" → 1회, "이혼숙려캠프 제102회" → 102회,
     * "제05회 260923" → 5회 + 날짜 26.09.23, "제01회~제04회" → 1~4회, "제23회~최종회" → 23회~최종회, "제8화(완)" → 8화 (완)
     */
    private fun epParse(label: String): Ep {
        val s = label.trim()
        fun fmt(n: String) = n.toBigDecimal().stripTrailingZeros().toPlainString()
        val head: String
        var rest: String
        val num: Float
        val r = EP_RANGE.find(s)
        val one = if (r == null) EP_ONE.find(s) else null
        when {
            r != null -> {
                val g = r.groupValues
                num = g[2].toFloat()
                head = "${fmt(g[2])}${g[3]}~${if (g[4] == "최종") "최종" else fmt(g[4])}${g[5]}"
                rest = g[6]
            }
            one != null -> {
                val g = one.groupValues
                num = g[2].toFloat()
                head = "${fmt(g[2])}${g[3]}"
                rest = g[4]
            }
            else -> return Ep(null, s, 0L)
        }
        rest = rest.trim()
        // 번호 뒤 6자리 날짜(yymmdd)는 날짜로
        var ms = 0L
        YYMMDD.find(rest)?.let { d ->
            val (y, mo, da) = d.destructured
            if (mo.toInt() in 1..12 && da.toInt() in 1..31) {
                ms = dayMs("20$y-$mo-$da")
                rest = rest.substring(d.value.length).trim()
            }
        }
        return Ep(num, head + if (rest.isNotEmpty()) " $rest" else "", ms)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val DEFAULT_BASE_URL = "https://tvtok11.com"
        private const val GUIDE_URL = "https://t.me/s/tvtok_url"
        private const val LIFETIME_URL = "https://xn--hg3ba87o95e83l04o.com/"
        private const val RATE_GAP_MS = 300L
        private const val PAGE_SIZE = 42
        private const val LABEL = "티비톡"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"
        private val DISCOVER_LOCK = Any()

        private val HOST_REGEX = Regex("""^(?:www\.)?tvtok\d*\.[a-z]{2,6}$""")
        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?tvtok\d*\.[a-z]{2,6}$""")
        private val GUIDE_HOST = Regex("""tvtok\d+\.com""", RegexOption.IGNORE_CASE)
        private val PASTE_HOST = Regex("""^(?:https?://)?((?:www\.)?tvtok\d*\.[a-z]{2,6})(?:/|$)""", RegexOption.IGNORE_CASE)
        private val WATCH_PATH = Regex("""/watch/([a-z_]+)/(\d+)""")
        private val EP_PARAM = Regex("""[?&]ep=(\d+)""")
        private val EP_RANGE = Regex("""^(.*?)(?:제\s*)?(\d+(?:\.\d+)?)\s*(회|화)?\s*[~\-]\s*(?:제\s*)?(\d+(?:\.\d+)?|최종)\s*(회|화)(.*)$""")
        private val EP_ONE = Regex("""^(.*?)(?:제\s*)?(\d+(?:\.\d+)?)\s*(회|화)(.*)$""")
        private val YYMMDD = Regex("""^(\d{2})(\d{2})(\d{2})(?!\d)\s*""")
        private val DATE_RE = Regex("""(\d{4})-(\d{1,2})-(\d{1,2})""")
        private val YEAR_IN_TITLE = Regex("""\((?:19|20)\d{2}\)""")

        private fun fmt(p: String) = object : ThreadLocal<SimpleDateFormat>() {
            override fun initialValue() = SimpleDateFormat(p, Locale.KOREA).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }
        }
        private val DAY_FMT = fmt("yyyy-M-d")
        private val MMDD_FMT = fmt("MM.dd")
        private val YEAR_FMT = fmt("yyyy")
        private val FULL_FMT = fmt("yyyy.MM.dd (E)")

        /** 분류 (이름, 사이트 값) — 첫째 top10 = 전체 작품 (키즈·애니는 사이트에 0개라 뺌) */
        private val LISTS = listOf(
            "전체" to "top10",
            "드라마" to "drama",
            "해외드라마" to "world",
            "추억드라마" to "old_drama",
            "예능" to "ent",
            "추억예능" to "old_ent",
            "해외예능/다큐" to "ott_ent",
            "시사/다큐" to "sisa",
            "해외영화" to "movie",
            "한국영화" to "kor_movie",
        )
        private val SORTS = listOf("최신순" to "", "인기순" to "popular", "평점순" to "rating")

        private val DEFAULT_POPULAR = intArrayOf(0, 1)
        private val DEFAULT_LATEST = intArrayOf(0, 0)
    }
}
