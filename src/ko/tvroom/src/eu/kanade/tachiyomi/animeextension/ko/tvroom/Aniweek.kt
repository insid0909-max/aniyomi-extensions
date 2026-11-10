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
import eu.kanade.tachiyomi.network.POST
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import rx.Observable
import java.io.ByteArrayInputStream
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 애니위크 (aniweek.com, 예비 ani.ohli24.com, 2026-11-10) — 망가요미 aniweek.js 0.1.0 과 같은 규칙.
 * 코티비씨·북코와 같은 Laravel+Inertia 시스템: 화면 안 <script data-page="app"> 에 화면 데이터(JSON).
 * 분류 /방영중(한 쪽) · /종영 · /극장판(?page=N), 필터·검색 /?keyword=&sort=&types[0]=&genres[0]=&years[0]=&page=N
 * 작품 /c/{slug} (props.comic + props.episodes 100개씩), 회차 /e/{slug} 의 props.playing.body.url = cdndania 플레이어
 * 재생: 플레이어 POST /player/index.php?data={ID}&do=getVideo → securedLink (애니울프·애니24 와 같은 플레이어) → 안 되면 숨은 WebView
 */
class Aniweek : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "애니위크"
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
        get() = DomainGuard.pick(prefs(), PREF_DOMAIN_KEY, DEFAULT_BASE_URL, autoDomain(), { DOMAIN_REGEX.matches(it) }, newerDefault = false)

    override val client: OkHttpClient = network.client.newBuilder()
        .apply { interceptors().add(0, FriendlyNet) }
        .addInterceptor(PageCache(Regex("^/c/")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS, skipImages = true))
        .addInterceptor { chain -> domainIntercept(chain) }
        .addInterceptor(RetryOnce(HOST_REGEX))
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("User-Agent", USER_AGENT)
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 주소 자동 찾기 (연결 실패·5xx·451 일 때만) =================
    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val baseHost = baseUrl.toHttpUrlOrNull()?.host
        if (baseHost == null || req.url.host != baseHost || !autoDomain()) return chain.proceed(req)

        fun retryOn(found: String): Response {
            adopt("https://$found")
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
        return res
    }

    /** 찾은 주소 저장. 번호 없는 주소라 번호 비교로 바뀌지 않으므로, 직접 넣은 주소가 끊겼으면 그 칸도 고침 */
    private fun adopt(url: String) {
        DomainGuard.saveAuto(prefs(), PREF_DOMAIN_KEY, url)
        val p = prefs() ?: return
        val manual = p.getString(PREF_DOMAIN_KEY, "")?.trim()?.trimEnd('/').orEmpty()
        if (DOMAIN_REGEX.matches(manual)) p.edit().putString(PREF_DOMAIN_KEY, url).apply()
    }

    private val plain by lazy {
        OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    /** 진짜 애니위크 화면이면 그 host (200 + 표시 글자) */
    private fun realHost(host: String): String? = runCatching {
        val r = Request.Builder().url("https://$host/").header("User-Agent", USER_AGENT).build()
        plain.newCall(r).execute().use { res ->
            val fh = res.request.url.host
            val body = res.peekBody(800_000).string()
            if (HOST_REGEX.matches(fh) && res.code == 200 && body.contains(ADDR_MARK) && body.contains("data-page")) fh else null
        }
    }.getOrNull()

    @Volatile private var lastDiscover = 0L

    /** 저장소 주소 목록 → 주소 안내(코사이트)에 적힌 주소 → 예비 주소 (1분에 한 번) */
    private fun discoverDomain(currentHost: String): String? = synchronized(DISCOVER_LOCK) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now
        val tries = LinkedHashSet<String>()
        DomainList.host("aniweek")?.let { tries.add(it) }
        runCatching {
            plain.newCall(Request.Builder().url(GUIDE_URL).header("User-Agent", USER_AGENT).build()).execute().use { r ->
                GUIDE_HOST.findAll(r.body.string()).forEach { tries.add(it.groupValues[1].lowercase()) }
            }
        }
        BACKUP_HOSTS.forEach { tries.add(it) }
        for (t in tries) {
            if (t == currentHost || !HOST_REGEX.matches(t)) continue
            realHost(t)?.let { return it }
        }
        null
    }

    // ================= 화면 데이터 =================
    private class Page(val props: JSONObject, val component: String, val version: String)

    private fun pageOf(html: String): Page {
        val raw = PAGE_SCRIPT.find(html)?.groupValues?.get(1)
            ?: PAGE_ATTR.find(html)?.groupValues?.get(2)?.let { decodeHtml(it) }
        val data = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
        val props = data?.optJSONObject("props")
        if (data == null || props == null) {
            val t = TITLE.find(html)?.groupValues?.get(1)?.trim().orEmpty()
            throw Exception("화면 데이터를 찾지 못했어요 [${t.ifEmpty { html.replace(Regex("\\s+"), " ").take(60) }}]")
        }
        return Page(props, data.optString("component"), data.optString("version"))
    }

    private fun decodeHtml(s: String): String = s.replace("&quot;", "\"").replace("&#039;", "'").replace("&#39;", "'")
        .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")

    private fun fetchPage(path: String, stage: String): Page {
        client.newCall(GET(baseUrl + path, h())).execute().use { res ->
            if (!res.isSuccessful) throw Exception("사이트 요청 실패 [$stage · HTTP ${res.code} · ${res.request.url.host}${path.substringBefore('?').take(40)}]")
            return pageOf(res.body.string())
        }
    }

    private fun encPath(p: String): String = p.split('/').joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }

    private fun JSONObject.str(k: String): String = if (isNull(k)) "" else optString(k)

    private fun isSeries(o: JSONObject): Boolean {
        if (o.str("title").isEmpty() || o.str("slug").isEmpty() || o.str("thumbnail").isEmpty()) return false
        if (o.has("series_id") || (o.has("body") && !o.isNull("body"))) return false
        val c = o.optJSONObject("content") ?: return true
        return c.optString("role") == "series"
    }

    /** 화면 데이터에서 작품을 두루 모음 (나온 순서, 겹치지 않게) + 다음 쪽이 있는지 */
    private fun collectSeries(props: JSONObject): Pair<List<JSONObject>, Boolean> {
        val out = mutableListOf<JSONObject>()
        val seen = HashSet<String>()
        var hasNext = false
        fun walk(x: Any?, depth: Int) {
            if (depth > 7) return
            when (x) {
                is JSONArray -> for (i in 0 until x.length()) walk(x.opt(i), depth + 1)
                is JSONObject -> {
                    if (isSeries(x)) {
                        if (seen.add(x.str("slug"))) out.add(x)
                        return
                    }
                    if (x.optJSONArray("data") != null && (x.has("current_page") || x.has("next_page_url"))) {
                        if (x.str("next_page_url").isNotEmpty() || (x.optInt("last_page") > 0 && x.optInt("current_page") < x.optInt("last_page"))) hasNext = true
                    }
                    val keys = x.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        if (depth == 0 && k in SKIP_KEYS) continue
                        walk(x.opt(k), depth + 1)
                    }
                }
            }
        }
        walk(props, 0)
        return out to hasNext
    }

    private fun imageOf(o: JSONObject): String? {
        val t = o.str("thumbnail").ifEmpty { o.str("background") }
        if (t.isEmpty()) return null
        if (t.startsWith("http")) return t
        return "$baseUrl/storage/" + t.removePrefix("/").removePrefix("storage/")
    }

    // ================= 목록 =================
    private fun cardOf(o: JSONObject): SAnime {
        val left = o.str("main_left").ifEmpty { o.str("date") }.trim()
        val t = o.str("title").trim()
        return SAnime.create().apply {
            url = "/c/" + o.str("slug")
            // 애니요미는 서재 제목을 갱신하지 않으므로 방영일은 넣지 않고, 끝난 작품만 (연도)
            title = if (YEAR_ONLY.matches(left) && !t.contains("($left)")) "$t ($left)" else t
            thumbnail_url = imageOf(o)
            status = if (DATE_START.containsMatchIn(left)) SAnime.ONGOING else SAnime.UNKNOWN
        }
    }

    private fun filterQuery(idx: IntArray): String {
        val q = mutableListOf("sort=${SORTS[idx[3]].second}")
        fun e(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        if (idx[0] > 0) q.add("types%5B0%5D=" + e(TYPES[idx[0]].second))
        if (idx[1] > 0) q.add("genres%5B0%5D=" + e(GENRES[idx[1]]))
        if (idx[2] > 0) q.add("years%5B0%5D=" + e(YEARS[idx[2]].second))
        return q.joinToString("&")
    }

    /** 종류만 고른 기본 정렬이면 원래 분류 화면(/방영중 등), 아니면 사이트 필터 주소. 방영중 화면은 한 쪽뿐 → 2쪽부터 null */
    private fun listPath(idx: IntArray, page: Int): String? {
        if (idx[0] > 0 && idx[1] == 0 && idx[2] == 0 && idx[3] == 0) {
            if (TYPES[idx[0]].second == "방영중" && page > 1) return null
            return encPath("/" + TYPES[idx[0]].second) + if (page > 1) "?page=$page" else ""
        }
        return "/?" + filterQuery(idx) + if (page > 1) "&page=$page" else ""
    }

    private fun listPage(idx: IntArray, page: Int): AnimesPage {
        val path = listPath(idx, page) ?: return AnimesPage(emptyList(), false)
        val p = fetchPage(path, "목록")
        val (items, hasNext) = collectSeries(p.props)
        if (items.isEmpty() && page == 1) {
            throw Exception("작품을 찾지 못했어요 [목록 · ${p.component} · ${p.props.keys().asSequence().joinToString(",").take(60)}]")
        }
        return AnimesPage(items.map(::cardOf), hasNext)
    }

    private fun ruleSizes() = intArrayOf(TYPES.size, GENRES.size, YEARS.size, SORTS.size)

    override fun fetchPopularAnime(page: Int): Observable<AnimesPage> = Observable.fromCallable {
        listPage(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page)
    }

    override fun fetchLatestUpdates(page: Int): Observable<AnimesPage> = Observable.fromCallable {
        listPage(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page)
    }

    // 검색 띄어쓰기: 결과가 없으면 띄어쓰기 뺀 검색어 등으로 다시 찾음(SearchSpacing)
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> =
        SearchSpacing.wrap(page, query) { q, p -> Observable.fromCallable { search(p, q, filters) } }

    private fun search(page: Int, query: String, filters: AnimeFilterList): AnimesPage {
        val q = query.trim()
        // 사이트 주소만 붙여 넣으면(https:// 없어도) 진짜 사이트인지 확인 후 그 주소로 바꾸고 인기 목록
        ONLY_HOST.find(q)?.let { m ->
            val host = m.groupValues[1].lowercase().removePrefix("www.")
            if (HOST_REGEX.matches(host)) {
                if (host != baseUrl.toHttpUrlOrNull()?.host) {
                    val real = realHost(host) ?: throw Exception("이 주소에서 애니위크 화면을 찾지 못했어요 [$host]")
                    prefs()?.edit()?.putString(PREF_DOMAIN_KEY, "https://$real")?.apply()
                }
                return listPage(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, 1)
            }
        }
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        PASTE.find(q)?.let { m ->
            val path = "/" + m.groupValues[1] + "/" + URLDecoder.decode(m.groupValues[2].replace("+", "%2B"), "UTF-8")
            val p = fetchPage(encPath(path), "작품")
            val o = p.props.optJSONObject("comic") ?: return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(cardOf(o)), false)
        }
        fun sel(f: AnimeFilter.Select<*>?) = f?.state ?: 0
        val idx = intArrayOf(
            sel(filters.filterIsInstance<TypeFilter>().firstOrNull()),
            sel(filters.filterIsInstance<GenreFilter>().firstOrNull()),
            sel(filters.filterIsInstance<YearFilter>().firstOrNull()),
            sel(filters.filterIsInstance<SortFilter>().firstOrNull()),
        )
        if (q.isEmpty()) {
            filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
            return listPage(idx, page)
        }
        // 검색: /?keyword=검색어 (필터와 함께 써도 됨). 결과 0개는 오류가 아니라 빈 목록
        val e = URLEncoder.encode(q, "UTF-8").replace("+", "%20")
        val fq = if (idx.any { it > 0 }) "&" + filterQuery(idx) else ""
        val p = fetchPage("/?keyword=$e$fq" + if (page > 1) "&page=$page" else "", "검색")
        val (items, hasNext) = collectSeries(p.props)
        val want = q.replace(Regex("\\s+"), "").lowercase()
        val hits = items.filter { it.str("title").replace(Regex("\\s+"), "").lowercase().contains(want) }
        return AnimesPage(hits.map(::cardOf), hasNext && hits.size == items.size)
    }

    override fun popularAnimeRequest(page: Int): Request = throw UnsupportedOperationException()
    override fun popularAnimeParse(response: Response): AnimesPage = throw UnsupportedOperationException()
    override fun latestUpdatesRequest(page: Int): Request = throw UnsupportedOperationException()
    override fun latestUpdatesParse(response: Response): AnimesPage = throw UnsupportedOperationException()
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = throw UnsupportedOperationException()
    override fun searchAnimeParse(response: Response): AnimesPage = throw UnsupportedOperationException()

    // ================= 작품 정보 =================
    private fun workPath(url: String): String = encPath(url.substringBefore('#'))

    override fun getAnimeUrl(anime: SAnime): String = baseUrl + workPath(anime.url)

    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + workPath(anime.url), h())

    override fun animeDetailsParse(response: Response): SAnime {
        val p = pageOf(response.body.string())
        val o = p.props.optJSONObject("comic") ?: collectSeries(p.props).first.firstOrNull()
            ?: throw Exception("작품 정보를 찾지 못했어요 [작품 · ${p.component}]")
        val eps = rawEpisodes(p, response.request.url.encodedPath, o)
        val last = eps.maxOfOrNull { timeMs(it.str("published_at")) } ?: 0L
        val movie = isMovie(o)
        val done = movie || o.str("category") == "종영" || o.str("completed_at").isNotEmpty() ||
            eps.any { it.str("title").contains("완결") }
        val year = timeMs(o.str("published_at")).takeIf { it > 0 }?.let { yearOf(it) }
        val rows = o.optJSONObject("metadata")?.optJSONArray("info_rows")
        val info = buildList {
            add("분류" to o.str("category"))
            if (rows != null && rows.length() > 0) {
                for (i in 0 until rows.length()) {
                    val r = rows.optJSONArray(i) ?: continue
                    add(r.optString(0) to r.optString(1))
                }
            } else {
                add("방송" to o.str("air_schedule"))
                add("감독" to o.str("director"))
                add("원작" to o.str("author"))
            }
        }.filter { it.second.isNotEmpty() && it.second != "정보없음" && it.second != "null" }
            .joinToString("\n") { "${it.first}: ${it.second}" }
        val tags = o.optJSONArray("tags")
        return SAnime.create().apply {
            val t = o.str("title").trim()
            title = if (done && year != null && !t.contains("($year)")) "$t ($year)" else t
            thumbnail_url = imageOf(o)
            author = o.str("author").ifEmpty { null }
            genre = (0 until (tags?.length() ?: 0)).mapNotNull { i ->
                val n = tags!!.optJSONObject(i)?.opt("name")
                (if (n is JSONObject) n.optString("ko") else n?.toString())?.takeIf { it.isNotEmpty() && it != "null" }
            }.ifEmpty { o.str("tags_string").split(',').map { it.trim() }.filter { it.isNotEmpty() } }
                .distinct().joinToString(", ").ifEmpty { null }
            status = if (done) SAnime.COMPLETED else SAnime.ONGOING
            if (movie) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            // 애니요미는 서재 제목을 갱신하지 않으므로 최근 방영일은 설명 맨 위에
            description = listOfNotNull(
                if (!done && last > 0) "방영 중 · 최근 방영: ${fmt(OUT_FMT, last)}" else null,
                Jsoup.parse(o.str("description").replace(Regex("(?i)<br\\s*/?>"), "\n")).wholeText().trim().ifEmpty { null },
                info.ifEmpty { null },
            ).joinToString("\n\n")
        }
    }

    private fun isMovie(o: JSONObject): Boolean =
        o.str("category") == "극장판" || o.optJSONObject("card_meta")?.optString("kind") == "movie"

    // ================= 회차 =================
    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + workPath(anime.url), h())

    /** 회차 자료 모으기: 100개씩 나뉜 쪽도 받고, 짧은 배열 모양([id, 제목, slug, 날짜])이면 부분 새로고침으로 전체 */
    private fun rawEpisodes(p: Page, path: String, o: JSONObject): List<JSONObject> {
        val raw = mutableListOf<JSONObject>()
        fun add(x: Any?) {
            val arr = when (x) {
                is JSONArray -> x
                is JSONObject -> x.optJSONArray("data")
                else -> null
            } ?: return
            for (i in 0 until arr.length()) {
                val e = arr.optJSONObject(i) ?: continue
                if ((e.has("body") || e.str("slug").isNotEmpty()) && (e.has("title") || e.has("sort"))) raw.add(e)
            }
        }
        val ep = p.props.opt("episodes")
        if (ep is JSONArray && ep.length() > 0 && ep.opt(0) is JSONArray) {
            var rows: JSONArray = ep
            if (p.props.optInt("episodesTotal", 0) > rows.length()) allEpisodeRows(path, p)?.let { if (it.length() > rows.length()) rows = it }
            val n = rows.length()
            for (i in 0 until n) {
                val r = rows.optJSONArray(i) ?: continue
                if (r.optString(2).isEmpty()) continue
                val num = NUM.find(r.optString(1))?.value?.toDoubleOrNull()
                raw.add(
                    JSONObject().put("title", r.optString(1)).put("slug", r.optString(2))
                        .put("published_at", r.opt(3) ?: JSONObject.NULL).put("sort", num ?: (n - i).toDouble()),
                )
            }
        } else {
            add(ep)
            if (raw.isEmpty()) add(o.opt("episodes"))
            val lastPage = ((ep as? JSONObject)?.optInt("last_page") ?: 1).coerceIn(1, 30)
            for (pg in 2..lastPage) {
                val more = runCatching { fetchPage("$path?page=$pg", "회차") }.getOrNull() ?: break
                add(more.props.opt("episodes"))
            }
        }
        return raw
    }

    private fun allEpisodeRows(path: String, p: Page): JSONArray? = runCatching {
        val hs = h().newBuilder()
            .set("X-Inertia", "true")
            .set("X-Inertia-Partial-Component", p.component.ifEmpty { "contents/List" })
            .set("X-Inertia-Partial-Data", "episodesAll")
            .set("X-Requested-With", "XMLHttpRequest")
            .set("Accept", "text/html, application/xhtml+xml")
            .apply { if (p.version.isNotEmpty()) set("X-Inertia-Version", p.version) }
            .build()
        client.newCall(GET(baseUrl + path, hs)).execute().use { res ->
            JSONObject(res.body.string()).optJSONObject("props")?.optJSONObject("episodesAll")?.optJSONArray("rows")
        }
    }.getOrNull()

    override fun episodeListParse(response: Response): List<SEpisode> {
        val p = pageOf(response.body.string())
        val o = p.props.optJSONObject("comic") ?: JSONObject()
        val raw = rawEpisodes(p, response.request.url.encodedPath, o)
        if (raw.isEmpty() && !isMovie(o)) {
            throw Exception("회차를 찾지 못했어요 [회차 · ${p.component} · episodes ${p.props.opt("episodes")?.javaClass?.simpleName ?: "없음"}]")
        }
        // 번호 칸(sort)이 없으면 이름의 "N화" 번호로
        val seen = HashSet<String>()
        val eps = raw.filter { seen.add(it.str("slug").ifEmpty { it.str("id") }) }.map { e ->
            val sort = if (e.has("sort") && !e.isNull("sort")) {
                e.optDouble("sort", 0.0)
            } else {
                (EP_NUM.find(e.str("title")) ?: LEAD_NUM.find(e.str("title").trim()))?.groupValues?.get(1)?.toDoubleOrNull() ?: 0.0
            }
            e to sort
        }
        // 최신 회차가 위 (번호 → 올린 시각). 번호가 겹치면("1막 3화"·"2막 3화") 올린 시각 순
        val nums = eps.map { it.second }.filter { it > 0 }
        val dup = nums.toSet().size < nums.size
        val sorted = eps.sortedWith(
            compareByDescending<Pair<JSONObject, Double>> { if (dup) 0.0 else it.second }
                .thenByDescending { timeMs(it.first.str("published_at")) },
        )
        val title = o.str("title").trim()
        val used = HashSet<Float>()
        val out = sorted.asReversed().mapIndexed { i, (e, sort) ->
            val t = e.str("title").trim()
            val at = timeMs(e.str("published_at").ifEmpty { e.str("created_at") })
            var n = if (!dup && sort > 0) sort.toFloat() else (i + 1).toFloat()
            while (!used.add(n)) n += 0.01f
            val base = if (t.firstOrNull()?.isDigit() == true) t else "${if (sort > 0) fmtNum(sort) else (i + 1).toString()}화${if (t.isEmpty() || t == title) "" else " $t"}"
            SEpisode.create().apply {
                val player = e.optJSONObject("body")?.str("url").orEmpty()
                url = "/e/" + e.str("slug") + if (player.isNotEmpty()) "#p=" + URLEncoder.encode(player, "UTF-8") else ""
                name = base + if (at > 0) " (${fmt(SHORT_FMT, at)})" else ""
                episode_number = n
                date_upload = at
            }
        }.asReversed()
        // 영화 회차 이름은 "본편" 으로 통일 (MovieName)
        return MovieName.unify(out)
    }

    private fun fmtNum(d: Double): String = if (d == Math.floor(d)) d.toLong().toString() else d.toString()

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val pagePath = episode.url.substringBefore('#')
        var player = episode.url.substringAfter("#p=", "").let { if (it.isEmpty()) "" else URLDecoder.decode(it, "UTF-8") }
        val pageUrl = baseUrl + encPath(pagePath)
        // 회차 화면에서 다시 확인 (플레이어 주소가 바뀌었을 수 있음)
        runCatching { fetchPage(encPath(pagePath), "회차 화면") }
            .onSuccess { p -> p.props.optJSONObject("playing")?.optJSONObject("body")?.str("url")?.takeIf { it.startsWith("http") }?.let { player = it } }
            .onFailure { if (player.isEmpty()) throw it }
        if (!player.startsWith("http")) throw Exception("이 회차에는 재생 화면이 없어요 [재생 · 플레이어 주소 없음]")
        val out = mutableListOf<Video>()
        if (MEDIA.containsMatchIn(player.substringBefore('?'))) {
            out += HlsQuality.expand(client, player, LABEL, h())
            return@withContext HlsQuality.sort(prefs(), out)
        }
        val why = mutableListOf<String>()
        val found = runCatching { firePlayer(player) }.onFailure { why.add(it.message.orEmpty().take(50)) }.getOrNull()
            ?: sniffWithWebView(player, pageUrl).also { if (it == null) why.add("웹뷰에서도 못 찾음") }
        if (found == null) throw Exception("영상 주소를 찾지 못했어요 [재생 · ${player.toHttpUrlOrNull()?.host} · ${why.joinToString(" · ")}]")
        out += HlsQuality.expand(client, found.first, LABEL, videoHeaders(found.second))
        HlsQuality.sort(prefs(), out)
    }

    /** 애니울프·애니24 와 같은 플레이어 요청: POST {플레이어}/player/index.php?data={ID}&do=getVideo → securedLink */
    private fun firePlayer(player: String): Pair<String, String> {
        val u = player.toHttpUrlOrNull() ?: throw Exception("플레이어 주소 모양")
        val vid = u.pathSegments.lastOrNull { it.isNotEmpty() } ?: throw Exception("플레이어 번호 없음")
        val origin = "${u.scheme}://${u.host}"
        val body = FormBody.Builder().add("hash", vid).add("r", "").build()
        val headers = Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", origin)
            .set("Origin", origin)
            .set("X-Requested-With", "XMLHttpRequest")
            .build()
        return client.newCall(POST("$origin/player/index.php?data=$vid&do=getVideo", headers, body)).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw Exception("플레이어 HTTP ${res.code}")
            val secured = runCatching { JSONObject(text).optString("securedLink") }.getOrNull()?.takeIf { it.startsWith("http") }
            val media = secured ?: M3U8.find(text.replace("\\/", "/"))?.value
                ?: throw Exception("플레이어 응답에 주소 없음 ${text.replace(Regex("\\s+"), " ").take(40)}")
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

    /** 숨은 WebView 로 플레이어를 열고, 처음 나오는 m3u8 요청 주소와 그 Referer 를 돌려줌 (애니울프와 같음) */
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
                // 처음엔 자동 재생을 막아 숨은 화면에서 소리가 나지 않게 (못 찾으면 아래에서 허용 후 다시)
                webView.settings.mediaPlaybackRequiresUserGesture = true
                webView.settings.userAgentString = USER_AGENT
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

    // ================= 날짜 =================
    /** "2026-10-29T12:28:23.000000Z" · "2026-10-29 21:28:23" (시간대 없으면 한국 시간) → ms */
    private fun timeMs(s: String): Long {
        val str = s.trim()
        if (str.isEmpty() || str == "null") return 0L
        if (Regex("^\\d{9,13}$").matches(str)) return str.toLong().let { if (it < 1_000_000_000_000L) it * 1000 else it }
        val m = DATE_RE.find(str) ?: return 0L
        val g = m.groupValues
        val zone = g[7]
        return try {
            val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
            cal.clear()
            cal.set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].ifEmpty { "0" }.toInt(), g[5].ifEmpty { "0" }.toInt(), g[6].ifEmpty { "0" }.toInt())
            var t = cal.timeInMillis
            if (zone.isEmpty()) {
                t -= 9 * 3_600_000L
            } else if (!zone.equals("Z", true)) {
                val z = Regex("([+-])(\\d{2}):?(\\d{2})").find(zone)!!.groupValues
                val off = (z[2].toInt() * 60 + z[3].toInt()) * 60_000L
                t -= if (z[1] == "+") off else -off
            }
            t
        } catch (e: Exception) {
            0L
        }
    }

    private fun fmt(f: SimpleDateFormat, ms: Long): String = synchronized(f) { f.format(java.util.Date(ms)) }

    private fun yearOf(ms: Long): Int = Calendar.getInstance(KST).apply { timeInMillis = ms }.get(Calendar.YEAR)

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("aniweek", baseFilters())

    private fun ruleText(i: IntArray): String = listOfNotNull(
        TYPES[i[0]].first,
        GENRES[i[1]].takeIf { i[1] > 0 },
        YEARS[i[2]].first.takeIf { i[2] > 0 },
        SORTS[i[3]].first.takeIf { i[3] > 0 },
    ).joinToString(" · ")

    private fun baseFilters(): AnimeFilterList = AnimeFilterList(
        listOf(
            AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")} · 자동 찾기 ${if (autoDomain()) "켜짐" else "꺼짐"}"),
            AnimeFilter.Separator(),
            AnimeFilter.Header("검색어와 함께 써도 됨 · 작품·사이트 주소를 붙여 넣으면 바로 열기"),
            TypeFilter(),
            GenreFilter(),
            YearFilter(),
            SortFilter(),
        ) + TabRule.filters(prefs(), ruleSizes(), ruleText(DEFAULT_POPULAR) to ruleText(DEFAULT_LATEST), ::ruleText),
    )

    class TypeFilter : AnimeFilter.Select<String>("분류", TYPES.map { it.first }.toTypedArray())
    class GenreFilter : AnimeFilter.Select<String>("장르", GENRES.toTypedArray())
    class YearFilter : AnimeFilter.Select<String>("연도", YEARS.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "애니위크 주소 직접 지정 (선택)"
            summary = "비워 두면 기본 주소($DEFAULT_BASE_URL) 또는 자동으로 찾은 주소를 씁니다. 예비 주소: https://ani.ohli24.com"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 주소 (예: https://aniweek.com · https://ani.ohli24.com)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://aniweek.com)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        SwitchPreferenceCompat(ctx).apply {
            key = PREF_AUTO_DOMAIN
            title = "주소 자동 찾기"
            summary = "접속이 안 되면 저장소 주소 목록·주소 안내(코사이트)·예비 주소(ani.ohli24.com)에서 새 주소를 찾습니다"
            setDefaultValue(true)
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val DEFAULT_BASE_URL = "https://aniweek.com"
        private const val RATE_GAP_MS = 300L
        private const val LABEL = "애니위크"
        private const val ADDR_MARK = "sister_sites"
        private const val GUIDE_URL = "https://korsite.net/"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"
        private val DISCOVER_LOCK = Any()

        private val HOST_REGEX = Regex("""^(?:(?:[a-z0-9]+\.)?aniweek\d*|ani\.ohli24\d*)\.[a-z]{2,6}$""")
        private val DOMAIN_REGEX = Regex("""^https://(?:(?:[a-z0-9]+\.)?aniweek\d*|ani\.ohli24\d*)\.[a-z]{2,6}$""")
        private val GUIDE_HOST = Regex("""https?://((?:(?:[a-z0-9]+\.)?aniweek\d*|ani\.ohli24\d*)\.[a-z]{2,6})""", RegexOption.IGNORE_CASE)
        private val BACKUP_HOSTS = listOf("aniweek.com", "ani.ohli24.com")
        private val ONLY_HOST = Regex("""^(?:https?://)?([^/?#\s]+)/?$""", RegexOption.IGNORE_CASE)
        private val PASTE = Regex("""(?:aniweek\d*|ani\.ohli24\d*)\.[a-z]{2,6}/(c|e)/([^?#\s/]+)""", RegexOption.IGNORE_CASE)
        private val PAGE_SCRIPT = Regex("""<script[^>]*data-page=["']app["'][^>]*>([\s\S]*?)</script>""")
        private val PAGE_ATTR = Regex("""data-page=(["'])([\s\S]*?)\1""")
        private val TITLE = Regex("""<title[^>]*>([^<]*)""")
        private val SKIP_KEYS = setOf("popular", "recentComments", "banner", "translations", "setting")
        private val YEAR_ONLY = Regex("""^\d{4}$""")
        private val DATE_START = Regex("""^\d{4}-\d{2}-\d{2}""")
        private val NUM = Regex("""\d+(?:\.\d+)?""")
        private val EP_NUM = Regex("""(\d+(?:\.\d+)?)\s*(?:화|회)""")
        private val LEAD_NUM = Regex("""^(\d+(?:\.\d+)?)""")
        private val MEDIA = Regex("""\.(m3u8|mp4)$""", RegexOption.IGNORE_CASE)
        private val M3U8 = Regex("""https?://[^"'\s<>]+\.m3u8[^"'\s<>]*""")
        private val DATE_RE = Regex("""^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?""", RegexOption.IGNORE_CASE)

        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val OUT_FMT = SimpleDateFormat("yyyy.MM.dd (E)", Locale.KOREA).apply { timeZone = KST }
        private val SHORT_FMT = SimpleDateFormat("MM.dd", Locale.KOREA).apply { timeZone = KST }

        // 필터 (번호 순서가 탭 규칙 저장 값과 맞아야 함). 사이트 필터 화면의 값 그대로 (망가요미판과 같음)
        private val TYPES = listOf("전체" to "", "방영중" to "방영중", "종영" to "종영", "극장판" to "극장판")
        private val GENRES = listOf(
            "전체", "액션", "판타지", "코미디", "개그", "로맨스", "연애", "일상", "드라마", "학원", "이세계", "모험", "SF", "메카닉",
            "미스터리", "추리", "공포", "스포츠", "음악", "아이돌", "하렘", "마법소녀", "전쟁", "역사", "시대", "요리", "성장", "청춘", "배틀",
            "능력", "요괴", "뱀파이어", "좀비", "게임", "BL", "백합", "19", "미스테리", "먼치킨", "마법", "범죄", "기타", "전투", "멘붕", "동물",
            "부활동", "미소녀", "퇴마", "괴물", "순정", "치유물", "변신", "영웅", "로리", "서스펜스", "정령", "격투", "드래곤", "메이드", "마녀",
            "군", "닌자", "다크 판타지", "마법사", "히어로", "레이싱", "악마", "버추얼 리얼리티", "신", "호러", "어드벤처", "마왕", "유령", "TS",
            "여행", "거대로봇",
        )
        private val YEARS = listOf("전체" to "") +
            (2026 downTo 2010).map { it.toString() to it.toString() } +
            listOf("2005~09" to "2005-2009", "2000~04" to "2000-2004", "1990년대" to "1990-1999", "1980년대" to "1980-1989", "1979년 이전" to "0-1979")
        private val SORTS = listOf(
            "업데이트 최신순" to "update-desc",
            "업데이트 오래된순" to "update-asc",
            "공개일 최신순" to "release-desc",
            "공개일 오래된순" to "release-asc",
            "별점 높은순" to "rating-desc",
            "제목 가나다순" to "title-asc",
        )

        // 인기 = 별점 높은순, 최신 = 업데이트 최신순
        private val DEFAULT_POPULAR = intArrayOf(0, 0, 0, 4)
        private val DEFAULT_LATEST = intArrayOf(0, 0, 0, 0)

        private val BLOCKED_HOSTS = listOf("googletagmanager.com", "google-analytics.com", "magsrv.com", "runative-syndicate.com")
    }
}
