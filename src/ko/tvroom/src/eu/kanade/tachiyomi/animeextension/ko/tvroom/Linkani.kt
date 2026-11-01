package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.app.Application
import android.content.SharedPreferences
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
import eu.kanade.tachiyomi.animesource.model.Track
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
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import java.net.URLEncoder

/**
 * 링크애니 (linkani.tv, "Linkkf 애니 TV").
 * 목록: /list/2/(전체) · /list/9/(Ani16+) [/class/{장르·요일}][/year/{연도}][/lang/{TV|Movie|OVA}][/page/N/],
 *   인기: /label/topday/[page/N/], 검색: /view/[page/N/]?wd=검색어 — 카드 div.vod-item
 * 작품: /ani/{번호}/ (정보 .detail-info-desc li, 회차 .episode-box a.ep — 최신이 위, 회차 날짜는 사이트에 없음)
 * 회차: /watch/{번호}/a1/k{N}/ 화면 안 var player_aaaa={…} 의 actual_url(m3u8)·subtitle_url(한국어 vtt).
 *   영상 주소에 짧은 기한(expires)이 붙어 있어 재생할 때마다 회차 화면을 새로 읽음.
 */
class Linkani : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "링크애니"
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
        .addInterceptor(PageCache(Regex("^/ani/\\d+/")))
        // 포스터도 사이트 주소(/anime_uploads/)에 있어 그림은 간격 없이 받음
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS, skipImages = true))
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
    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    /** idx = [목록, 장르, 요일, 연도, 종류] */
    private fun listUrl(idx: IntArray, page: Int): String {
        val pageSuffix = if (page > 1) "page/$page/" else ""
        if (idx[0] == RANKING) return "$baseUrl/label/topday/$pageSuffix"
        val sb = StringBuilder("$baseUrl${LISTS[idx[0]].second}")
        // 사이트는 분류(class)를 하나만 받음 → 요일을 고르면 요일, 아니면 장르
        val cls = when {
            idx[2] > 0 -> DAYS[idx[2]]
            idx[1] > 0 -> GENRES[idx[1]].second
            else -> null
        }
        if (cls != null) sb.append("class/").append(enc(cls)).append('/')
        if (idx[3] > 0) sb.append("year/").append(YEARS[idx[3]]).append('/')
        if (idx[4] > 0) sb.append("lang/").append(TYPES[idx[4]].second).append('/')
        return sb.append(pageSuffix).toString()
    }

    private fun ruleSizes() = intArrayOf(LISTS.size, GENRES.size, DAYS.size, YEARS.size, TYPES.size)

    // 기본: 인기 = 오늘 인기 순위, 최신 = 전체 애니(최근 올라온 순)
    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        PASTE_REGEX.find(q)?.let { m -> return GET("$baseUrl/ani/${m.groupValues[1]}/", h()) }
        if (q.isNotEmpty()) {
            val pagePart = if (page > 1) "page/$page/" else ""
            return GET("$baseUrl/view/$pagePart?wd=${enc(q)}", h())
        }
        fun sel(f: AnimeFilter.Select<*>?) = f?.state ?: 0
        val idx = intArrayOf(
            sel(filters.filterIsInstance<ListFilter>().firstOrNull()),
            sel(filters.filterIsInstance<GenreFilter>().firstOrNull()),
            sel(filters.filterIsInstance<DayFilter>().firstOrNull()),
            sel(filters.filterIsInstance<YearFilter>().firstOrNull()),
            sel(filters.filterIsInstance<TypeFilter>().firstOrNull()),
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val path = response.request.url.encodedPath
        if (DETAIL_PATH.matches(path)) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { url = path }), false)
        }
        return parseList(response)
    }

    /** 목록·검색 화면의 작품 카드(div.vod-item) */
    private fun parseList(response: Response): AnimesPage {
        val doc = Jsoup.parse(response.body.string(), response.request.url.toString())
        val seen = HashSet<String>()
        val animes = doc.select(".vod-list .vod-item").mapNotNull { item ->
            val a = item.selectFirst("h3.vod-item-title a[href]") ?: item.selectFirst("a.vod-item-img[href]") ?: return@mapNotNull null
            val path = a.attr("abs:href").toHttpUrlOrNull()?.encodedPath ?: return@mapNotNull null
            if (!DETAIL_PATH.matches(path) || !seen.add(path)) return@mapNotNull null
            val t = item.selectFirst("h3.vod-item-title")?.text()?.trim().orEmpty()
            if (t.isEmpty()) return@mapNotNull null
            // 검색 카드에는 "TV 2007 . 720/720" 처럼 연도가 있음 (같은 제목 구별용)
            val year = YEAR_REGEX.find(item.selectFirst(".vod-item-info p")?.text().orEmpty())?.value
            SAnime.create().apply {
                url = path
                title = if (year != null && !t.contains("($year)")) "$t ($year)" else t
                thumbnail_url = item.selectFirst(".img-wrapper[data-original]")?.attr("abs:data-original")?.ifEmpty { null }
            }
        }
        return AnimesPage(animes, hasNext(doc, response.request.url.encodedPath))
    }

    /** 쪽 번호 링크 중 지금 쪽 + 1 이 있으면 다음 쪽이 있음 */
    private fun hasNext(doc: Document, path: String): Boolean {
        val cur = PAGE_REGEX.find(path)?.groupValues?.get(1)?.toIntOrNull() ?: 1
        return doc.select("a[href]").any { a ->
            PAGE_REGEX.find(a.attr("href"))?.groupValues?.get(1)?.toIntOrNull() == cur + 1
        }
    }

    // ================= 작품 정보 =================
    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())

    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url

    /** "장르：액션 / 모험 /" → "장르" to "액션, 모험" */
    private fun info(doc: Document): Map<String, String> = doc.select(".detail-info-desc li").mapNotNull { li ->
        val key = li.selectFirst("span")?.text()?.replace("：", "")?.replace(":", "")?.trim().orEmpty()
        if (key.isEmpty()) return@mapNotNull null
        val links = li.select("a").map { it.text().trim() }.filter { it.isNotEmpty() }
        val value = if (links.isNotEmpty()) links.joinToString(", ") else li.ownText().trim()
        key to value
    }.toMap()

    override fun animeDetailsParse(response: Response): SAnime {
        val doc = Jsoup.parse(response.body.string(), response.request.url.toString())
        val m = info(doc)
        val t = doc.selectFirst("h1.detail-info-title")?.text()?.trim().orEmpty()
        val year = m["년"]?.let { YEAR_REGEX.find(it)?.value }
        val type = m["분류"].orEmpty()
        return SAnime.create().apply {
            // 사이트에 방영 중 여부가 없어 연도만 붙임 (같은 제목 구별용, 바뀌지 않는 정보)
            title = if (t.isNotEmpty() && year != null && !t.contains("($year)")) "$t ($year)" else t
            thumbnail_url = doc.selectFirst(".detail-img [data-original]")?.attr("abs:data-original")?.ifEmpty { null }
                ?: doc.selectFirst("meta[property=og:image]")?.attr("content")?.ifEmpty { null }
            genre = m["장르"]?.ifEmpty { null }
            author = m["제작사"]?.ifEmpty { null }
            status = SAnime.UNKNOWN
            if (type.equals("Movie", true)) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            val story = doc.selectFirst("meta[name=description]")?.attr("content")?.trim().orEmpty()
                .removePrefix("$t 다시보기.").trim()
            val lines = listOfNotNull(
                type.ifEmpty { null }?.let { "분류: $it" },
                year?.let { "연도: $it" },
                m["총화수"]?.ifEmpty { null }?.let { "총화수: $it" },
                "자막: 한국어",
            ).joinToString("\n")
            description = listOfNotNull(story.ifEmpty { null }, lines).joinToString("\n\n")
        }
    }

    // ================= 회차 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val doc = Jsoup.parse(response.body.string(), response.request.url.toString())
        val used = HashSet<Float>()
        return doc.select(".episode-box a.ep[href], .episode-box a[href*='/watch/']").mapNotNull { a ->
            val path = a.attr("abs:href").toHttpUrlOrNull()?.encodedPath ?: return@mapNotNull null
            val m = WATCH_PATH.find(path) ?: return@mapNotNull null
            path to (m.groupValues[1] to a.text().trim())
        }.distinctBy { it.first }.mapIndexed { i, (path, v) ->
            val (key, label) = v
            // 회차 번호는 주소의 kN (이름이 "1179화" 이거나 회차 제목일 때도 있음)
            var n = KEY_NUM.find(key)?.value?.toFloatOrNull() ?: (i + 1).toFloat()
            while (!used.add(n)) n += 0.01f
            val shown = KEY_NUM.find(key)?.value ?: key
            SEpisode.create().apply {
                url = path
                name = when {
                    label.isEmpty() || label == shown || label == "${shown}화" -> "${shown}화"
                    else -> "${shown}화 $label"
                }
                episode_number = n
            }
        }
    }

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val pageUrl = baseUrl + episode.url
        val html = client.newCall(GET(pageUrl, h())).execute().use { res ->
            if (!res.isSuccessful) throw Exception("회차 화면을 열지 못했습니다 (HTTP ${res.code})")
            res.body.string()
        }
        val player = playerData(html) ?: throw Exception("이 회차에는 재생 정보가 없습니다")
        val main = str(player, "actual_url").ifEmpty { str(player, "url") }
        if (!main.startsWith("http")) throw Exception("영상 주소를 찾지 못했습니다")
        val sub = str(player, "subtitle_url")
        val subs = if (sub.startsWith("http")) listOf(Track(sub, "한국어")) else emptyList()
        val vh = Headers.Builder()
            .set("User-Agent", USER_AGENT)
            .set("Referer", "$baseUrl/")
            .set("Origin", baseUrl)
            .build()
        val label = HlsQuality.withRes(LABEL, main).let { if (subs.isEmpty()) it else "$it 자막" }
        val list = HlsQuality.expand(client, main, label, vh).map { Video(it.url, it.quality, it.videoUrl, vh, subs) }
        HlsQuality.sort(prefs(), list)
    }

    private fun str(o: JSONObject, k: String): String = if (o.isNull(k)) "" else o.optString(k).trim()

    /** 화면 글 안 var player_aaaa={…}; 의 JSON (중괄호 짝을 한 글자씩 세어 끝을 찾음) */
    private fun playerData(html: String): JSONObject? {
        val start = html.indexOf("player_aaaa")
        if (start < 0) return null
        val brace = html.indexOf('{', start)
        if (brace < 0) return null
        var depth = 0
        var quoted = false
        var escaped = false
        for (i in brace until html.length) {
            val c = html[i]
            if (quoted) {
                when {
                    escaped -> escaped = false
                    c == '\\' -> escaped = true
                    c == '"' -> quoted = false
                }
                continue
            }
            when (c) {
                '"' -> quoted = true
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return runCatching { JSONObject(html.substring(brace, i + 1)) }.getOrNull()
                }
            }
        }
        return null
    }

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    // 맨 위에 최근 업데이트 내역(📝)
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("linkani", baseFilters())

    private fun baseFilters(): AnimeFilterList {
        fun text(i: IntArray): String {
            if (i[0] == RANKING) return LISTS[i[0]].first
            return listOfNotNull(
                LISTS[i[0]].first,
                GENRES[i[1]].first.takeIf { i[1] > 0 && i[2] == 0 },
                DAYS[i[2]].takeIf { i[2] > 0 }?.let { "${it}요일" },
                YEARS[i[3]].takeIf { i[3] > 0 },
                TYPES[i[4]].first.takeIf { i[4] > 0 },
            ).joinToString(" · ")
        }
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}"),
                AnimeFilter.Separator(),
                AnimeFilter.Header("검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)"),
                ListFilter(),
                GenreFilter(),
                DayFilter(),
                YearFilter(),
                TypeFilter(),
                AnimeFilter.Header("오늘 인기 순위는 다른 조건 없이 순위만 보여 줌. 요일을 고르면 장르 대신 요일"),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class ListFilter : AnimeFilter.Select<String>("목록", LISTS.map { it.first }.toTypedArray())
    class GenreFilter : AnimeFilter.Select<String>("장르", GENRES.map { it.first }.toTypedArray())
    class DayFilter : AnimeFilter.Select<String>("요일", DAYS.map { if (it == "전체") it else "${it}요일" }.toTypedArray())
    class YearFilter : AnimeFilter.Select<String>("연도", YEARS.toTypedArray())
    class TypeFilter : AnimeFilter.Select<String>("종류", TYPES.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "링크애니 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다. 사이트가 새 주소로 넘겨 주면 자동으로 저장됩니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 링크애니 주소 (예: https://linkani.tv)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://linkani.tv)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val DEFAULT_BASE_URL = "https://linkani.tv"
        private const val RATE_GAP_MS = 300L
        private const val LABEL = "링크애니"
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"

        // linkani.tv · linkani2.tv … · linkkf.live 같은 같은 사이트 주소
        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?(?:linkani\d*|linkkf\d*)\.[a-z]{2,6}$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?(?:linkani\d*|linkkf\d*)\.[a-z]{2,6}$""")
        private val PASTE_REGEX = Regex("""(?:linkani\d*|linkkf\d*)\.[a-z]{2,6}/(?:ani|watch)/(\d+)""")
        private val DETAIL_PATH = Regex("""^/ani/\d+/?$""")
        private val WATCH_PATH = Regex("""^/watch/\d+/[^/]+/([^/]+)/?$""")
        private val KEY_NUM = Regex("""\d+(?:\.\d+)?""")
        private val PAGE_REGEX = Regex("""/page/(\d+)/""")
        private val YEAR_REGEX = Regex("""(?<!\d)(?:19|20)\d{2}(?!\d)""")

        /** 목록 (이름, 주소). 마지막 = 오늘 인기 순위 */
        private val LISTS = listOf("전체 애니" to "/list/2/", "Ani16+" to "/list/9/", "오늘 인기 순위" to "/label/topday/")
        private const val RANKING = 2

        /** 장르 (한국어 이름, 사이트 값) — 사이트 목록의 Genres 그대로 */
        private val GENRES = listOf(
            "전체" to "",
            "액션" to "Action",
            "모험" to "Adventure",
            "아방가르드" to "Avant Garde",
            "BL" to "Boys Love",
            "코미디" to "Comedy",
            "드라마" to "Drama",
            "판타지" to "Fantasy",
            "GL(백합)" to "Girls Love",
            "요리·음식" to "Gourmet",
            "공포" to "Horror",
            "미스터리" to "Mystery",
            "로맨스" to "Romance",
            "SF" to "Sci-Fi",
            "일상" to "Slice of Life",
            "스포츠" to "Sports",
            "초자연" to "Supernatural",
            "서스펜스" to "Suspense",
            "청년(세이넨)" to "Seinen",
            "소녀(쇼죠)" to "Shoujo",
            "소년(쇼넨)" to "Shounen",
            "밀리터리" to "Military",
            "음악" to "Music",
            "학원" to "School",
            "웹툰 원작" to "Webtoon",
            "중국 애니" to "CN Animation",
        )

        /** 요일 (사이트 분류 값 그대로) */
        private val DAYS = listOf("전체", "월", "화", "수", "목", "금", "토", "일")

        /** 연도 (사이트 목록: 올해 ~ 1990) */
        private val YEARS = listOf("전체") + (maxOf(2026, java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)) downTo 1990).map { it.toString() }

        /** 종류 (이름, 사이트 값) */
        private val TYPES = listOf("전체" to "", "TV" to "TV", "극장판" to "Movie", "OVA" to "OVA")

        private val DEFAULT_POPULAR = intArrayOf(RANKING, 0, 0, 0, 0)
        private val DEFAULT_LATEST = intArrayOf(0, 0, 0, 0, 0)
    }
}
