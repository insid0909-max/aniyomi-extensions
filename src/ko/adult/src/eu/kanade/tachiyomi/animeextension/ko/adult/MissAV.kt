package eu.kanade.tachiyomi.animeextension.ko.adult

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
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import rx.Observable
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * MissAV (missav123.com, 2026-11-09, 망가요미판 my-ext missav.js 0.0.4 와 같은 규칙).
 * 사이트가 Cloudflare 확인을 써서 해외에서는 열어 보지 못함 → 망가요미판(휴대폰에서 됨)과 같은 방법으로 만듦.
 * 목록·검색은 화면의 작품 링크(/ko/abc-123 · /dm270/ko/abc-123)를 모음. 재생은 작품 화면을 숨은 WebView 로 열어
 * 플레이어가 불러온 m3u8 을 받음. User-Agent 는 휴대폰 웹뷰의 실제 값(WebUa, Cloudflare 통과 쿠키가 그 값에 묶임).
 */
class MissAV : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "MissAV"
    override val lang = "ko"
    override val supportsLatest = true

    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    // 주소: 설정에 직접 넣은 주소 → 검색창에 붙여 넣어 바꾼 주소 → 기본 주소
    override val baseUrl: String
        get() {
            val p = prefs()
            var v = p?.getString(PREF_DOMAIN, "")?.trim()?.trimEnd('/').orEmpty()
            if (v.isNotEmpty() && !v.startsWith("http")) v = "https://$v"
            if (DOMAIN_REGEX.matches(v)) return v
            val auto = p?.getString(PREF_AUTO_DOMAIN, "")?.trim().orEmpty()
            return if (DOMAIN_REGEX.matches(auto)) auto else DEFAULT_BASE_URL
        }

    override val client: OkHttpClient = network.client.newBuilder()
        .apply { interceptors().add(0, FriendlyNet) }
        .build()

    // User-Agent 는 휴대폰 웹뷰의 실제 값(WebUa) — 앱 기본값(PC 크롬 이름)이면 웹뷰에서 푼 Cloudflare 확인이 계속 다시 걸림
    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .apply { WebUa.value()?.let { set("User-Agent", it) } }
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 목록 =================
    private fun ruleSizes() = intArrayOf(CATS.size, SORTS.size)

    private fun defaultList(): String {
        val v = prefs()?.getString(PREF_LIST, "")?.trim().orEmpty()
        val list = if (v.startsWith("http")) v else DEFAULT_LIST
        return list.replace(SITE_PREFIX, baseUrl)
    }

    private fun setParam(url: String, key: String, value: String): String {
        val re = Regex("""([?&])$key=[^&]*""")
        if (re.containsMatchIn(url)) return url.replace(re, "$1$key=$value")
        return url + (if (url.contains('?')) "&" else "?") + "$key=$value"
    }

    private fun pageUrl(listUrl: String, page: Int): String {
        val u = listUrl.replace(Regex("""([?&])page=\d+&?"""), "$1").trimEnd('?', '&')
        if (page <= 1) return u
        return u + (if (u.contains('?')) "&" else "?") + "page=$page"
    }

    private fun listByRule(idx: IntArray, page: Int): String {
        var url = if (idx[0] > 0) baseUrl + CATS[idx[0]].second else defaultList()
        if (idx[1] > 0) url = setParam(url, "sort", SORTS[idx[1]].second)
        return pageUrl(url, page)
    }

    override fun popularAnimeRequest(page: Int): Request =
        GET(listByRule(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listByRule(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    // 사이트 주소만(https:// 없어도) 붙여 넣으면 그 주소로 바꾸고 인기 목록, 작품·목록 주소면 그 화면
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val site = PASTE_REGEX.find(query.trim())
        if (site != null) {
            return Observable.fromCallable { adoptDomain("https://${site.groupValues[1].lowercase()}") }.flatMap<AnimesPage> {
                val path = site.groupValues[2]
                if (path.isEmpty() || Regex("""^/(?:dm\d+/)?(?:[a-z]{2}/?)?$""").matches(path)) {
                    fetchPopularAnime(page)
                } else {
                    super.fetchSearchAnime(page, query, filters)
                }
            }
        }
        return super.fetchSearchAnime(page, query, filters)
    }

    /** 붙여 넣은 새 사이트 주소가 MissAV 화면(또는 Cloudflare 확인 화면)이면 저장 */
    private fun adoptDomain(origin: String) {
        if (!DOMAIN_REGEX.matches(origin) || origin == baseUrl) return
        val ok = runCatching {
            client.newCall(GET("$origin/ko", Headers.headersOf("Referer", "$origin/"))).execute().use { res ->
                val body = res.body.string()
                Regex("""MISS</span>|MissAV""", RegexOption.IGNORE_CASE).containsMatchIn(body) ||
                    CF_REGEX.containsMatchIn(body.take(3000))
            }
        }.getOrDefault(false)
        if (!ok) throw Exception("${origin.removePrefix("https://")} 는 MissAV 화면이 아니에요. 주소를 다시 확인해 주세요.")
        prefs()?.edit()?.putString(PREF_AUTO_DOMAIN, origin)?.apply()
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        if (SITE_PATH_REGEX.containsMatchIn(q)) {
            val url = (if (q.startsWith("http")) q else "https://$q").replace(SITE_PREFIX, baseUrl)
            return GET(if (POST_REGEX.matches(cleanLink(url))) cleanLink(url) else pageUrl(url, page), h())
        }
        val idx = intArrayOf(
            filters.filterIsInstance<CatFilter>().firstOrNull()?.state ?: 0,
            filters.filterIsInstance<SortFilter>().firstOrNull()?.state ?: 0,
        )
        if (q.isNotEmpty()) {
            var url = "$baseUrl/ko/search/${URLEncoder.encode(q, "UTF-8").replace("+", "%20")}"
            if (idx[1] > 0) url = setParam(url, "sort", SORTS[idx[1]].second)
            return GET(pageUrl(url, page), h())
        }
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listByRule(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val url = cleanLink(response.request.url.toString())
        if (POST_REGEX.matches(url)) {
            if (pageOf(response) > 1) return AnimesPage(emptyList(), false)
            val d = animeDetailsParse(response)
            return AnimesPage(listOf(d.apply { this.url = relPath(url) }), false)
        }
        return parseList(response)
    }

    private fun pageOf(response: Response) = response.request.url.queryParameter("page")?.toIntOrNull() ?: 1

    private fun cleanLink(u: String) = u.substringBefore('#').substringBefore('?').trimEnd('/')

    private fun relPath(u: String) = u.toHttpUrlOrNull()?.encodedPath ?: u

    private fun imgOf(el: Element?): String {
        el ?: return ""
        for (a in listOf("data-src", "data-original", "data-lazy-src", "src")) {
            val v = el.attr("abs:$a").trim()
            if (v.isNotEmpty() && !v.startsWith("data:")) return v
        }
        return ""
    }

    private class Card(val link: String, var name: String = "", var image: String = "")

    /** 화면의 작품 링크를 모음. 카드 하나에 그림 링크와 제목 링크가 따로 있어 합침, 제목은 가장 긴 글자 */
    private fun parseList(response: Response): AnimesPage {
        val html = checked(response)
        val doc = Jsoup.parse(html, response.request.url.toString())
        val page = pageOf(response)
        val byLink = LinkedHashMap<String, Card>()
        for (a in doc.select("a[href]")) {
            val link = cleanLink(a.attr("abs:href"))
            if (!POST_REGEX.matches(link)) continue
            val card = byLink.getOrPut(link) { Card(link) }
            val img = a.selectFirst("img")
            if (img != null && card.image.isEmpty()) card.image = imgOf(img)
            val text = a.text().trim()
            val cand = a.attr("title").trim().ifEmpty { if (text.length > 3) text else img?.attr("alt")?.trim().orEmpty() }
            if (cand.length > card.name.length) card.name = cand
        }
        val animes = byLink.values.filter { it.image.isNotEmpty() }.map { c ->
            SAnime.create().apply {
                url = relPath(c.link)
                title = c.name.ifEmpty { c.link.substringAfterLast('/').uppercase() }
                thumbnail_url = c.image
            }
        }
        val next = html.contains("page=${page + 1}") || doc.select("a[rel=next]").isNotEmpty()
        return AnimesPage(animes, animes.isNotEmpty() && next)
    }

    /** Cloudflare 확인 화면이면 할 일을 알려 줌 */
    private fun checked(response: Response): String {
        val body = response.body.string()
        if (response.code == 403 || response.code == 503 || CF_REGEX.containsMatchIn(body.take(3000))) {
            throw Exception("Cloudflare 확인이 필요해요. 메뉴 → WebView 로 사이트를 한 번 열어 확인을 통과한 뒤 다시 시도해 주세요.")
        }
        if (response.code >= 400) {
            throw Exception("MissAV 접속 실패 (HTTP ${response.code}). 주소가 바뀌었으면 새 사이트 주소(예: missav.live)를 검색창에 붙여 넣어 주세요.")
        }
        return body
    }

    // ================= 작품 정보 =================
    override fun getAnimeUrl(anime: SAnime): String = baseUrl + anime.url

    private class Detail(val title: String, val image: String?, val genres: List<String>, val date: Long, val year: String?, val desc: String)

    private fun detail(response: Response): Detail {
        val html = checked(response)
        val doc: Document = Jsoup.parse(html, response.request.url.toString())
        fun meta(p: String) = (doc.selectFirst("meta[property=$p]") ?: doc.selectFirst("meta[name=$p]"))?.attr("content")?.trim().orEmpty()
        val name = doc.selectFirst("h1")?.text()?.trim()?.ifEmpty { null } ?: meta("og:title")
        val genres = doc.select("a[href*='/genres/'], a[href*='/actresses/'], a[href*='/makers/']")
            .map { it.text().trim() }.filter { it.isNotEmpty() && it.length < 40 }.distinct()
        // 출시일: time[datetime] 또는 "출시일/발매일/Release date" 옆의 yyyy-MM-dd
        val date = doc.selectFirst("time[datetime]")?.attr("datetime")?.let { YMD.find(it)?.value }
            ?: RELEASE_REGEX.find(html)?.groupValues?.get(1)
        val m = date?.let { YMD_PARTS.find(it) }
        val ms = m?.let {
            Calendar.getInstance(KST).apply {
                clear()
                set(it.groupValues[1].toInt(), it.groupValues[2].toInt() - 1, it.groupValues[3].toInt())
            }.timeInMillis
        } ?: 0L
        return Detail(name, meta("og:image").ifEmpty { null }, genres, ms, m?.groupValues?.get(1), meta("og:description").ifEmpty { meta("description") })
    }

    override fun animeDetailsParse(response: Response): SAnime {
        val d = detail(response)
        return SAnime.create().apply {
            title = if (d.year != null && d.title.isNotEmpty() && !TITLE_YEAR.containsMatchIn(d.title)) "${d.title} (${d.year})" else d.title
            thumbnail_url = d.image
            genre = d.genres.joinToString(", ").ifEmpty { null }
            status = SAnime.COMPLETED
            update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            description = listOfNotNull(if (d.date > 0) "출시일: ${ymd(d.date)}" else null, d.desc.ifEmpty { null }).joinToString("\n\n")
        }
    }

    // ================= 회차 (영화처럼 하나: "본편") =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val d = detail(response)
        return listOf(
            SEpisode.create().apply {
                url = relPath(cleanLink(response.request.url.toString()))
                name = if (d.date > 0) "본편 (${ymd(d.date)})" else "본편"
                episode_number = 1f
                date_upload = d.date
            },
        )
    }

    private fun ymd(ms: Long) = synchronized(YMD_FMT) { YMD_FMT.format(java.util.Date(ms)) }

    // ================= 재생 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val url = baseUrl + episode.url
        val ua = h()["User-Agent"]
        val r = WebSniff.m3u8(url, "$baseUrl/", ua)
        val origin = r.lastPage.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" } ?: baseUrl
        val headers = Headers.Builder().apply {
            if (!ua.isNullOrBlank()) set("User-Agent", ua)
            set("Referer", "$origin/")
            set("Origin", origin)
        }.build()
        // 주 목록(playlist.m3u8)은 화질별로 나눔(자동 + 1080p·720p…), 그 밖의 주소는 이름에 화질
        val main = r.urls.firstOrNull { it.contains("playlist.m3u8") }
        val out = mutableListOf<Video>()
        if (main != null) out.addAll(HlsQuality.expand(client, main, LABEL, headers))
        for (u in r.urls) {
            if (u == main || out.any { it.url == u }) continue
            out.add(Video(u, HlsQuality.withRes(LABEL, u), u, headers))
        }
        if (out.isEmpty()) throw Exception("영상 주소를 못 찾았어요 [메뉴 → WebView 로 Cloudflare 확인을 통과했는지 봐 주세요]")
        HlsQuality.sort(prefs(), out)
    }

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("missav", baseFilters())

    private fun baseFilters(): AnimeFilterList {
        fun text(i: IntArray) = listOfNotNull(CATS[i[0]].first, if (i[1] > 0) SORTS[i[1]].first else null).joinToString(" · ")
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}"),
                AnimeFilter.Header("검색창에 사이트 주소를 붙여 넣으면 그 주소로 바꾸고, 작품·목록 주소면 그 화면을 열어요"),
                AnimeFilter.Separator(),
                AnimeFilter.Header("분류: 검색어가 없을 때 적용 · 정렬: 검색 결과·분류 모두 적용"),
                CatFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class CatFilter : AnimeFilter.Select<String>("분류", CATS.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_LIST
            title = "기본 목록 주소 (분류 \"설정의 목록\")"
            summary = "비워 두면 첫 화면(dm270/ko). 인기·최신 탭은 필터의 탭 규칙으로 바꿀 수 있어요."
            dialogMessage = "사이트의 목록 화면 주소 (예: $DEFAULT_LIST)"
            setDefaultValue("")
        }.also(screen::addPreference)
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN
            title = "사이트 주소 직접 지정 (선택)"
            summary = "비워 두면 $DEFAULT_BASE_URL 을 사용합니다.\n현재 주소: $baseUrl"
            dialogMessage = "https:// 로 시작하는 주소 (주소가 바뀌면 여기에, 또는 검색창에 붙여 넣기)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                var input = (newValue as String).trim().trimEnd('/')
                if (input.isNotEmpty() && !input.startsWith("http")) input = "https://$input"
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: $DEFAULT_BASE_URL)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)
        HlsQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN = "pref_domain_key"
        private const val PREF_AUTO_DOMAIN = "pref_domain_key_auto"
        private const val PREF_LIST = "pref_list_url"
        private const val DEFAULT_BASE_URL = "https://missav123.com"
        private const val DEFAULT_LIST = "https://missav123.com/dm270/ko"
        private const val LABEL = "MissAV"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?missav[a-z0-9]*\.[a-z]{2,6}$""")
        private val SITE_PREFIX = Regex("""^https?://(?:www\.)?missav[a-z0-9]*\.[a-z]{2,6}""")
        private val PASTE_REGEX = Regex("""^(?:https?://)?((?:www\.)?missav[a-z0-9]*\.[a-z]{2,6})(/\S*)?$""", RegexOption.IGNORE_CASE)
        private val SITE_PATH_REGEX = Regex("""^(?:https?://)?(?:www\.)?missav[a-z0-9]*\.[a-z]{2,6}/""", RegexOption.IGNORE_CASE)

        // 작품 주소: /ko/abc-123, /dm270/ko/abc-123, /ko/fc2-ppv-1234567 (목록·분류 주소는 제외)
        private val POST_REGEX = Regex("""^https?://[^/]+/(?:dm\d+/)?ko/[a-z0-9][a-z0-9_-]*\d[a-z0-9_-]*$""", RegexOption.IGNORE_CASE)
        private val CF_REGEX = Regex("""Just a moment|cf-chl|challenge-platform""", RegexOption.IGNORE_CASE)
        private val YMD = Regex("""\d{4}-\d{2}-\d{2}""")
        private val YMD_PARTS = Regex("""(\d{4})-(\d{2})-(\d{2})""")
        private val RELEASE_REGEX = Regex("""(?:출시일|발매일|Release date)[^0-9]{0,80}(\d{4}-\d{2}-\d{2})""", RegexOption.IGNORE_CASE)
        private val TITLE_YEAR = Regex("""\(\d{4}\)$""")
        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val YMD_FMT = SimpleDateFormat("yyyy.MM.dd", Locale.KOREA).apply { timeZone = KST }

        // 분류 (사이트 메뉴 그대로, 2026-10-28 메뉴 기준). 0번은 설정의 목록 주소
        private val CATS = listOf(
            "설정의 목록" to "",
            "최근 업데이트" to "/dm539/ko/new", "새로운 출시" to "/dm635/ko/release", "무수정 누출" to "/dm817/ko/uncensored-leak",
            "오늘 가장 많이 본" to "/dm301/ko/today-hot", "주별로 가장 많이 본" to "/dm170/ko/weekly-hot",
            "월별 가장 많이 본" to "/dm273/ko/monthly-hot", "영어 자막" to "/dm23/ko/english-subtitle", "VR" to "/ko/genres/VR",
            "아마추어 · SIRO" to "/dm36/ko/siro", "아마추어 · LUXU" to "/dm34/ko/luxu", "아마추어 · GANA" to "/dm34/ko/gana",
            "아마추어 · PRESTIGE PREMIUM" to "/dm1004/ko/maan", "아마추어 · S-CUTE" to "/dm38/ko/scute", "아마추어 · ARA" to "/dm34/ko/ara",
            "일본노모 · FC2" to "/dm597/ko/fc2", "일본노모 · HEYZO" to "/dm2208642/ko/heyzo", "일본노모 · Tokyo Hot" to "/dm42/ko/tokyohot",
            "일본노모 · 1pondo" to "/dm4551174/ko/1pondo", "일본노모 · Caribbeancom" to "/dm6840521/ko/caribbeancom",
            "일본노모 · Caribbeancompr" to "/dm91887/ko/caribbeancompr", "일본노모 · 10musume" to "/dm6238682/ko/10musume",
            "일본노모 · pacopacomama" to "/dm3600557/ko/pacopacomama", "일본노모 · Gachinco" to "/dm150/ko/gachinco",
            "일본노모 · XXX-AV" to "/dm42/ko/xxxav", "일본노모 · 유부녀 베기" to "/dm37/ko/marriedslash",
            "일본노모 · 야한 4610" to "/dm33/ko/naughty4610", "일본노모 · 야한 0930" to "/dm37/ko/naughty0930",
            "아시아 · Madou" to "/dm63/ko/madou", "아시아 · TWAV" to "/dm31/ko/twav", "아시아 · Furuke" to "/dm15/ko/furuke",
            "아시아 · 코리안 라이브" to "/ko/klive", "아시아 · 중국어 라이브" to "/ko/clive",
        )

        // 정렬 (사이트 주소의 sort= 값). 0번은 목록 그대로
        private val SORTS = listOf(
            "목록 그대로" to "",
            "최근 업데이트" to "published_at",
            "발매일" to "released_at",
            "저장 많은 순" to "saved",
            "오늘 조회" to "today_views",
            "주간 조회" to "weekly_views",
            "월간 조회" to "monthly_views",
            "전체 조회" to "views",
        )

        private val DEFAULT_POPULAR = intArrayOf(0, 0)
        private val DEFAULT_LATEST = intArrayOf(0, 1)
    }
}
