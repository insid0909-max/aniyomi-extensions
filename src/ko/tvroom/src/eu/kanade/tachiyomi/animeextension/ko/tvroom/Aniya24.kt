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
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import rx.Observable
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * 애니야24 (www.aniya24.com, 2026-11-09, 망가요미 aniya24.js(개인 저장소 my-ext)와 같은 구조).
 * 워드프레스(vidmov 테마). 목록 /series/ · /series-category/{분류}/ + page/N/ + ?orderby=, 검색 /?s=&post_type=vidmov_series,
 * 작품 /series/{이름}/ (회차 .main-series-items .series-item), 재생 Bunny Stream —
 * 회차 그림 주소(vz-….b-cdn.net/{영상ID}/thumbnail.jpg)의 영상ID → {영상ID}/playlist.m3u8 (Referer iframe.mediadelivery.net 필요, AES-128).
 * 사이트가 Cloudflare 보안 확인을 걸 때가 있음 → 앱의 보안 확인 처리(웹뷰)와 통과 쿠키가 맞도록 User-Agent 는 앱 기본값 그대로 둠.
 */
class Aniya24 : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "애니야24"
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
            var custom = prefs()?.getString(PREF_DOMAIN_KEY, "")?.trim()?.trimEnd('/').orEmpty()
            if (custom.isNotEmpty() && !custom.startsWith("http")) custom = "https://$custom"
            return if (DOMAIN_REGEX.matches(custom)) custom else DEFAULT_BASE_URL
        }

    override val client: OkHttpClient = network.client.newBuilder()
        .apply { interceptors().add(0, FriendlyNet) }
        .addInterceptor(PageCache(Regex("^/series/[^/]+/?$")))
        .addInterceptor(SiteRateLimit(HOST_REGEX, RATE_GAP_MS, skipImages = true))
        .addInterceptor { chain ->
            // 목록 끝을 넘은 쪽(…/page/N/)은 404 → 빈 화면으로 바꿔 "더 없음" 으로 처리 (오류 화면 대신)
            val req = chain.request()
            val res = chain.proceed(req)
            if (res.code == 404 && HOST_REGEX.matches(req.url.host) && PAGE_PATH.containsMatchIn(req.url.encodedPath)) {
                res.close()
                Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body("".toResponseBody(null)).build()
            } else {
                res
            }
        }
        .addInterceptor(RetryOnce(HOST_REGEX))
        .build()

    // User-Agent 는 앱 기본값(웹뷰와 같은 값) 그대로 — 보안 확인 통과 쿠키가 그 값에 묶여 있음
    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")

    private fun h(): Headers = headersBuilder().build()

    // ================= 목록 =================
    private fun listUrl(idx: IntArray, page: Int): String {
        val slug = KINDS[idx[0]].second
        var p = if (slug.isEmpty()) "/series/" else "/series-category/${URLEncoder.encode(slug, "UTF-8")}/"
        if (page > 1) p += "page/$page/"
        return "$baseUrl$p?${SORTS[idx[1]].second}"
    }

    private fun ruleSizes() = intArrayOf(KINDS.size, SORTS.size)

    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), true, ruleSizes()) ?: DEFAULT_POPULAR, page), h())

    override fun popularAnimeParse(response: Response): AnimesPage = parseList(response)

    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(TabRule.read(prefs(), false, ruleSizes()) ?: DEFAULT_LATEST, page), h())

    override fun latestUpdatesParse(response: Response): AnimesPage = parseList(response)

    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> =
        SearchSpacing.wrap(page, query) { q, p -> super.fetchSearchAnime(p, q, filters) }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        // 작품·회차 주소를 붙여 넣으면 그 작품을 바로 열기
        PASTE_REGEX.find(q)?.let { m -> return GET("$baseUrl/series/${m.groupValues[1]}/", h()) }
        if (q.isNotEmpty()) {
            val pre = if (page > 1) "/page/$page/" else "/"
            return GET("$baseUrl$pre?s=${URLEncoder.encode(q, "UTF-8")}&post_type=vidmov_series", h())
        }
        val idx = intArrayOf(
            filters.filterIsInstance<KindFilter>().firstOrNull()?.state ?: 0,
            filters.filterIsInstance<SortFilter>().firstOrNull()?.state ?: 0,
        )
        filters.filterIsInstance<TabRule.RuleFilter>().firstOrNull()?.let { TabRule.apply(prefs(), it.state, idx) }
        return GET(listUrl(idx, page), h())
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val path = response.request.url.encodedPath
        if (SERIES_PATH.matches(path)) {
            val d = animeDetailsParse(response)
            if (d.title.isEmpty()) return AnimesPage(emptyList(), false)
            return AnimesPage(listOf(d.apply { url = seriesPath(path) ?: path }), false)
        }
        return parseList(response)
    }

    /** 목록 화면의 작품 카드 (옆 칸 "최신 업로드" 카드는 빼려고 본문(#main-content) 안만) */
    private fun parseList(response: Response): AnimesPage {
        val html = response.body.string()
        if (html.isEmpty()) return AnimesPage(emptyList(), false)
        val doc = Jsoup.parse(html, response.request.url.toString())
        val page = PAGE_NUM.find(response.request.url.encodedPath)?.groupValues?.get(1)?.toIntOrNull() ?: 1
        val cards = doc.select("#main-content article.post-item").ifEmpty { doc.select("article.post-item") }
        val seen = HashSet<String>()
        val animes = cards.mapNotNull { card ->
            val a = card.selectFirst("a.post-listing-title") ?: card.selectFirst("a[href]") ?: return@mapNotNull null
            val path = seriesPath(a.attr("abs:href")) ?: return@mapNotNull null
            if (!seen.add(path)) return@mapNotNull null
            SAnime.create().apply {
                url = path
                title = a.attr("title").ifEmpty { a.text() }.trim()
                val img = card.selectFirst("img.blog-img") ?: card.selectFirst("img")
                thumbnail_url = img?.let { i -> i.attr("abs:data-src").ifEmpty { i.attr("abs:src") } }?.let(::fixUrl)
            }
        }
        // 쪽 번호 링크가 있거나 쪽이 꽉 차 보이면 다음 쪽이 있다고 봄 (빈 쪽·404 면 끝)
        val hasNext = animes.isNotEmpty() && (html.contains("/page/${page + 1}/") || animes.size >= 8)
        return AnimesPage(animes, hasNext)
    }

    /** 한글 파일 이름 등을 %XX 로 */
    private fun fixUrl(u: String): String? = u.takeIf { it.startsWith("http") }?.let { it.toHttpUrlOrNull()?.toString() ?: it }

    /** 작품·회차 주소 → "/series/이름/" (아니면 null) */
    private fun seriesPath(href: String): String? {
        val u = (if (href.startsWith("http")) href else baseUrl + href).toHttpUrlOrNull() ?: return null
        if (!HOST_REGEX.matches(u.host)) return null
        val seg = u.encodedPathSegments
        if (seg.size < 2 || seg[0] != "series" || seg[1].isEmpty()) return null
        return "/series/${seg[1].lowercase()}/"
    }

    // ================= 작품 정보 =================
    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + (seriesPath(anime.url) ?: anime.url), h())

    override fun getAnimeUrl(anime: SAnime): String = baseUrl + (seriesPath(anime.url) ?: anime.url)

    private class Info(
        val title: String,
        val cats: List<String>,
        val genres: List<String>,
        val status: String,
        val release: List<String>,
        val original: String?,
        val modified: Long,
    )

    private fun info(doc: Document, html: String): Info {
        val title = (doc.selectFirst("#main-content h1.entry-title") ?: doc.selectFirst("h1.entry-title"))?.text()?.trim()
            ?: doc.selectFirst("meta[property=og:title]")?.attr("content").orEmpty()
        val cats = doc.select(".special-style a.category-item").map { it.text().trim() }.filter { it.isNotEmpty() }.distinct()
        val banner = doc.selectFirst(".tmdb-movie-banner")
        val bannerText = banner?.text().orEmpty()
        val genres = banner?.select(".item-text")?.map { it.text().trim() }?.filter { it.isNotEmpty() && !it.contains(':') }?.distinct().orEmpty()
        val status = STATUS_REGEX.find(bannerText)?.groupValues?.get(1)?.trim().orEmpty()
        val release = RELEASE_REGEX.find(bannerText)?.groupValues?.drop(1).orEmpty()
        val original = doc.selectFirst(".tmdb-original-title")?.text()?.trim()?.ifEmpty { null }
        val modified = MODIFIED_REGEX.find(html)?.groupValues?.get(1)?.let { s ->
            runCatching { synchronized(ISO_FMT) { ISO_FMT.parse(s.substring(0, 19)) }?.time }.getOrNull()
        } ?: 0L
        return Info(title, cats, genres, status, release, original, modified)
    }

    private fun isOngoing(i: Info): Boolean = when {
        ONGOING_STATUS.containsMatchIn(i.status) -> true
        DONE_STATUS.containsMatchIn(i.status) || i.cats.contains("극장판") -> false
        else -> i.modified > 0 && System.currentTimeMillis() - i.modified < 21L * 86_400_000L
    }

    override fun animeDetailsParse(response: Response): SAnime {
        val html = response.body.string()
        val doc = Jsoup.parse(html, response.request.url.toString())
        val i = info(doc, html)
        val ongoing = isOngoing(i)
        val movie = i.cats.contains("극장판")
        val year = i.release.getOrNull(0)
        return SAnime.create().apply {
            // 애니요미는 서재 제목을 갱신하지 않아 방영일은 제목에 넣지 않음 (끝난 작품만 연도)
            title = if (!ongoing && year != null && !i.title.contains("($year)")) "${i.title} ($year)" else i.title
            thumbnail_url = (doc.selectFirst("meta[property=og:image]")?.attr("content") ?: doc.selectFirst("img.tmdb-picture")?.attr("abs:src"))
                ?.let(::fixUrl)
            genre = (i.cats.filter { !it.equals("TV Shows", true) } + i.genres.filter { it !in i.cats }).joinToString(", ").ifEmpty { null }
            status = if (ongoing) SAnime.ONGOING else SAnime.COMPLETED
            if (movie) update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            var story = doc.selectFirst(".entry-content-in-single")?.text()?.trim().orEmpty()
            if (story.endsWith(i.title)) story = story.dropLast(i.title.length).trim()
            val infoText = listOfNotNull(
                i.original?.let { "원제: $it" },
                if (i.release.size == 3) "${if (movie) "개봉" else "방영"}: ${i.release.joinToString(".")}" else null,
                i.cats.takeIf { it.isNotEmpty() }?.let { "분류: ${it.joinToString(", ")}" },
            ).joinToString("\n")
            description = listOfNotNull(
                if (ongoing && i.modified > 0) "방영 중 · 최근 갱신: ${synchronized(OUT_FMT) { OUT_FMT.format(java.util.Date(i.modified)) }}" else null,
                story.ifEmpty { null },
                infoText.ifEmpty { null },
            ).joinToString("\n\n")
        }
    }

    // ================= 회차 =================
    override fun episodeListRequest(anime: SAnime): Request = animeDetailsRequest(anime)

    // 영화 회차 이름은 "본편" 으로 통일 (MovieName)
    override fun episodeListParse(response: Response): List<SEpisode> = MovieName.unify(parseEpisodes(response))

    private class Ep(val path: String, val group: String, val label: String)

    private fun parseEpisodes(response: Response): List<SEpisode> {
        val html = response.body.string()
        val doc = Jsoup.parse(html, response.request.url.toString())
        val title = info(doc, html).title
        val seen = HashSet<String>()
        val groups = mutableListOf<String>()
        val raw = doc.select(".main-series-items .series-item").mapNotNull { item ->
            val a = item.selectFirst("a.post-listing-title") ?: item.selectFirst("a[href]") ?: return@mapNotNull null
            val u = a.attr("abs:href").toHttpUrlOrNull() ?: return@mapNotNull null
            if (!HOST_REGEX.matches(u.host)) return@mapNotNull null
            val path = u.encodedPath
            val mid = MEDIA_ID.find(path)?.groupValues?.get(1) ?: return@mapNotNull null
            if (!seen.add(mid)) return@mapNotNull null
            val g = GROUP_ID.find(path)?.groupValues?.get(1) ?: "0"
            if (g !in groups) groups.add(g)
            var label = a.attr("title").ifEmpty { a.text() }.replace(Regex("""\s+"""), " ").trim()
            label = when {
                label == title -> ""
                title.isNotEmpty() && label.startsWith(title) && label.length > title.length -> label.substring(title.length).trim()
                else -> label
            }
            // 회차 그림 = 그 회차 영상의 미리보기 → 재생 때 사이트를 다시 안 받으려고 주소 # 뒤에 적어 둠
            val thumb = item.selectFirst("img")?.let { it.attr("data-src").ifEmpty { it.attr("src") } }.orEmpty()
            val bunny = BUNNY_THUMB.find(thumb)?.let { "#bunny=${it.groupValues[1]}/${it.groupValues[2]}" }.orEmpty()
            Ep(path + bunny, g, label)
        }.toMutableList()
        // 회차 목록이 없으면 작품 화면 자체(첫 영상)를 하나로
        if (raw.isEmpty() && html.contains("beeteam368_pro_player(")) raw.add(Ep(response.request.url.encodedPath, "0", ""))
        fun num(s: String) = (EP_NUM.find(s) ?: LEAD_NUM.find(s))?.groupValues?.get(1)?.toFloatOrNull()
        // 사이트는 1화가 위 → 최신이 위가 되게 뒤집음 (번호가 거꾸로면 그대로)
        val n0 = raw.firstOrNull()?.let { num(it.label) }
        val n1 = raw.lastOrNull()?.let { num(it.label) }
        val ordered = if (n0 != null && n1 != null && n0 > n1) raw.reversed() else raw
        val used = HashSet<Float>()
        return ordered.mapIndexed { i, e ->
            var n = num(e.label) ?: (i + 1).toFloat()
            while (!used.add(n)) n += 0.01f
            val label = e.label.ifEmpty { title }
            SEpisode.create().apply {
                url = e.path
                name = if (groups.size > 1) "시즌${groups.indexOf(e.group) + 1} $label" else label
                episode_number = n
                date_upload = 0L
            }
        }.reversed()
    }

    // ================= 영상 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val media = Headers.Builder()
            .set("Referer", "$PLAYER_ORIGIN/")
            .set("Origin", PLAYER_ORIGIN)
            .build()
        // 빠른 길: 회차 주소에 적어 둔 영상 번호로 바로 재생 목록
        BUNNY_FRAG.find(episode.url)?.let { m ->
            val url = "https://${m.groupValues[1]}/${m.groupValues[2]}/playlist.m3u8"
            HlsQuality.expandIfWorks(client, url, LABEL, media)?.let { return@withContext HlsQuality.sort(prefs(), it) }
        }
        // 느린 길: 회차 화면의 플레이어 설정에서 영상 주소
        val path = episode.url.substringBefore('#')
        val pageUrl = (baseUrl + path).toHttpUrlOrNull()?.toString() ?: (baseUrl + path)
        val html = client.newCall(GET(pageUrl, h())).execute().use { res ->
            if (!res.isSuccessful) throw Exception("회차 화면을 열지 못했습니다 (HTTP ${res.code})")
            res.body.string()
        }
        val at = html.indexOf("beeteam368_pro_player(")
        val cfg = if (at >= 0) runCatching { JSONObject(braceBlock(html, html.indexOf('{', at))) }.getOrNull() else null
        // 설정 안의 광고 영상(video_ads_params)은 쓰지 않고 video_url 만
        val vurl = cfg?.optString("video_url").orEmpty()
        val poster = cfg?.optString("video_poster").orEmpty()
        val bunny = BUNNY_EMBED.find(vurl)
        if (bunny != null) {
            val guid = bunny.groupValues[2]
            Regex("""^https://([^/]+\.b-cdn\.net)/$guid/""", RegexOption.IGNORE_CASE).find(poster)?.let { pm ->
                HlsQuality.expandIfWorks(client, "https://${pm.groupValues[1]}/$guid/playlist.m3u8", LABEL, media)
                    ?.let { return@withContext HlsQuality.sort(prefs(), it) }
            }
            // 플레이어 화면에 적힌 재생 목록 주소
            val emb = runCatching {
                client.newCall(GET("$PLAYER_ORIGIN/embed/${bunny.groupValues[1]}/$guid", Headers.headersOf("Referer", pageUrl))).execute()
                    .use { it.body.string() }
            }.getOrDefault("")
            Regex("""https://[^"'\s]+/$guid/playlist\.m3u8[^"'\s]*""").find(emb)?.let { pm ->
                HlsQuality.expandIfWorks(client, pm.value.replace("&amp;", "&"), LABEL, media)
                    ?.let { return@withContext HlsQuality.sort(prefs(), it) }
            }
            throw Exception("영상 주소를 찾지 못했습니다 [플레이어 ${guid.take(8)}]")
        }
        DIRECT_MEDIA.find(vurl)?.let { m ->
            val vh = Headers.headersOf("Referer", pageUrl)
            return@withContext HlsQuality.sort(prefs(), HlsQuality.expand(client, m.value, LABEL, vh))
        }
        throw Exception("영상 주소를 찾지 못했습니다 [${if (cfg == null) "플레이어 설정 없음" else "다른 플레이어"}]")
    }

    /** "{...}" 를 중괄호 수를 세어 꺼냄 (글자 안의 중괄호는 무시) */
    private fun braceBlock(s: String, start: Int): String {
        if (start < 0) return ""
        var depth = 0
        var quote: Char? = null
        var i = start
        while (i < s.length) {
            val c = s[i]
            if (quote != null) {
                if (c == '\\') {
                    i++
                } else if (c == quote) {
                    quote = null
                }
            } else if (c == '"' || c == '\'') {
                quote = c
            } else if (c == '{') {
                depth++
            } else if (c == '}') {
                depth--
                if (depth == 0) return s.substring(start, i + 1)
            }
            i++
        }
        return ""
    }

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    override fun getFilterList(): AnimeFilterList = ExtStatus.withNotes("aniya24", baseFilters())

    private fun baseFilters(): AnimeFilterList {
        fun text(i: IntArray) = "${KINDS[i[0]].first} · ${SORTS[i[1]].first}"
        return AnimeFilterList(
            listOf(
                AnimeFilter.Header("📡 주소: ${baseUrl.substringAfter("://")}"),
                AnimeFilter.Separator(),
                AnimeFilter.Header("검색어가 없을 때만 적용 (작품 주소를 붙여 넣으면 바로 열기)"),
                KindFilter(),
                SortFilter(),
            ) + TabRule.filters(prefs(), ruleSizes(), text(DEFAULT_POPULAR) to text(DEFAULT_LATEST), ::text),
        )
    }

    class KindFilter : AnimeFilter.Select<String>("분류", KINDS.map { it.first }.toTypedArray())
    class SortFilter : AnimeFilter.Select<String>("정렬", SORTS.map { it.first }.toTypedArray())

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context
        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "애니야24 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 애니야24 주소 (예: https://www.aniya24.com)"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                if (input.isEmpty() || DOMAIN_REGEX.matches(input)) {
                    summary = "현재 주소: ${input.ifEmpty { DEFAULT_BASE_URL }}"
                    true
                } else {
                    Toast.makeText(ctx, "올바른 주소 형식이 아닙니다 (예: https://www.aniya24.com)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }.also(screen::addPreference)

        HlsQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val DEFAULT_BASE_URL = "https://www.aniya24.com"
        private const val PLAYER_ORIGIN = "https://iframe.mediadelivery.net"
        private const val RATE_GAP_MS = 300L
        private const val LABEL = "애니야24"

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?aniya24\d*\.[a-z]{2,6}$""")
        private val HOST_REGEX = Regex("""^(?:www\.)?aniya24\d*\.[a-z]{2,6}$""")
        private val PASTE_REGEX = Regex("""aniya24\d*\.[a-z]{2,6}/series/([^/?#\s]+)""", RegexOption.IGNORE_CASE)
        private val SERIES_PATH = Regex("""^/series/[^/]+/?$""")
        private val PAGE_PATH = Regex("""/page/\d+/?$""")
        private val PAGE_NUM = Regex("""/page/(\d+)/?$""")
        private val MEDIA_ID = Regex("""media-query-id/(\d+)""")
        private val GROUP_ID = Regex("""group-query-id/(\d+)""")
        private val BUNNY_THUMB = Regex("""^https://([^/]+\.b-cdn\.net)/([0-9a-f-]{36})/""", RegexOption.IGNORE_CASE)
        private val BUNNY_FRAG = Regex("""#bunny=([^/]+\.b-cdn\.net)/([0-9a-f-]{36})""", RegexOption.IGNORE_CASE)
        private val BUNNY_EMBED = Regex("""mediadelivery\.net\\?/(?:embed|play)\\?/(\d+)\\?/([0-9a-f-]{36})""", RegexOption.IGNORE_CASE)
        private val DIRECT_MEDIA = Regex("""https?://[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*""", RegexOption.IGNORE_CASE)
        private val EP_NUM = Regex("""(\d+(?:\.\d+)?)\s*(?:화|회|話)""")
        private val LEAD_NUM = Regex("""^(\d+)""")
        private val STATUS_REGEX = Regex("""Status:\s*([A-Za-z ]+?)(?:\s+(?:Release|First|Last)|$)""")
        private val RELEASE_REGEX = Regex("""(?:Release Date|First Air(?:ed| Date)?):\s*((?:19|20)\d{2})-(\d{2})-(\d{2})""", RegexOption.IGNORE_CASE)
        private val MODIFIED_REGEX = Regex("""article:modified_time"\s+content="([^"]+)""")
        private val ONGOING_STATUS = Regex("""Returning|In Production|Planned""", RegexOption.IGNORE_CASE)
        private val DONE_STATUS = Regex("""Ended|Released|Canceled""", RegexOption.IGNORE_CASE)

        private val KST = TimeZone.getTimeZone("Asia/Seoul")
        private val ISO_FMT = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        private val OUT_FMT = SimpleDateFormat("yyyy.MM.dd (E)", Locale.KOREA).apply { timeZone = KST }

        /** 분류 (사이트 주소의 분류 이름 그대로) */
        private val KINDS = listOf(
            "전체" to "", "극장판" to "극장판", "TV 애니" to "tv-shows", "일반" to "일반", "19+" to "19", "청불" to "청불",
            "동인지" to "동인지", "OAD" to "oad", "액션" to "액션", "판타지" to "판타지", "학원" to "학원", "로멘스" to "로멘스",
            "SF" to "sf", "공포" to "공포", "미스테리" to "미스테리", "범죄 스릴러" to "범죄-스릴러", "추리" to "추리",
            "스포츠" to "스포츠", "코미디" to "코미디", "전쟁" to "전쟁",
        )
        private val SORTS = listOf(
            "최근 업데이트" to "orderby=modified&order=DESC",
            "새로 올라온 순" to "orderby=date&order=DESC",
            "제목순" to "orderby=title&order=ASC",
        )

        private val DEFAULT_POPULAR = intArrayOf(2, 0)
        private val DEFAULT_LATEST = intArrayOf(0, 0)
    }
}
