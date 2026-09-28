package eu.kanade.tachiyomi.animeextension.ko.tvroom

import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.ParsedAnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.net.URLEncoder

class TVroom : ParsedAnimeHttpSource() {

    override val name = "티비위키"
    override val baseUrl = "https://tvwiki51.net"
    override val lang = "ko"
    override val supportsLatest = true

    override val client: OkHttpClient = network.client

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
        .add("Referer", "$baseUrl/")

    // ============================== 인기 목록 ==============================
    override fun popularAnimeRequest(page: Int): Request =
        GET("$baseUrl/popular?page=$page", headers)

    // 망가요미와 동일한 카드 블록 셀렉터
    override fun popularAnimeSelector(): String =
        "#list_type .box, #line_type .box, #mov_con_list .box, div.box, .slide_popular .box"

    override fun popularAnimeFromElement(element: Element): SAnime = SAnime.create().apply {
        val link = element.selectFirst("a.title2, a.title, a.img, a[href]")!!
        setUrlWithoutDomain(link.attr("href"))

        val titleNode = element.selectFirst("a.title2, a.title, .subject, .title")
        val imgNode = element.selectFirst("img")

        val rawTitle = titleNode?.attr("title")?.ifEmpty { null }
            ?: titleNode?.text()?.trim()?.ifEmpty { null }
            ?: imgNode?.attr("alt")?.trim()?.ifEmpty { null }
            ?: link.text().trim()

        title = cleanSeriesTitle(rawTitle)

        thumbnail_url = imgNode?.let { img ->
            val src = img.attr("data-original").ifEmpty {
                img.attr("data-src").ifEmpty {
                    img.attr("src")
                }
            }
            fixUrl(src)
        }
    }

    override fun popularAnimeNextPageSelector(): String? =
        "a[rel='next'], .pg_next, .pagination .next, a:contains(다음)"

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = response.asJsoup()
        var elements = document.select(popularAnimeSelector())

        // 만약 지정된 box 셀렉터가 없으면 a 링크 기반으로 자동 탐색
        if (elements.isEmpty()) {
            elements = document.select("a[href~=^/(movie|kor_movie|drama|ent|ani|foreign_drama|docu)/\\d+$]")
        }

        val animeList = ArrayList<SAnime>()
        for (el in elements) {
            runCatching {
                val anime = popularAnimeFromElement(el)
                if (anime.url.isNotBlank() && !anime.url.contains("notice")) {
                    animeList.add(anime)
                }
            }
        }

        val uniqueList = animeList.distinctBy { it.url }
        val hasNextPage = popularAnimeNextPageSelector()?.let { document.selectFirst(it) } != null
        return AnimesPage(uniqueList, hasNextPage)
    }

    // ============================== 최신 목록 ==============================
    override fun latestUpdatesRequest(page: Int): Request =
        GET("$baseUrl/drama?page=$page", headers)

    override fun latestUpdatesSelector(): String = popularAnimeSelector()
    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ============================== 검색 및 필터 ==============================
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        if (query.isNotBlank()) {
            val encodedQuery = URLEncoder.encode(query, "UTF-8")
            return GET("$baseUrl/search?stx=$encodedQuery&sst=subIdx&page=$page", headers)
        }

        var category = "all"
        var period = "d"
        var mode = "latest"

        filters.forEach { filter ->
            when (filter) {
                is CategoryFilter -> category = CATEGORIES[filter.state].second
                is PeriodFilter -> period = PERIODS[filter.state].second
                is ModeFilter -> mode = MODES[filter.state].second
                else -> {}
            }
        }

        val url = if (mode == "popular") {
            val catParam = if (category != "all") "&sb=$category" else ""
            "$baseUrl/popular?period=$period$catParam&page=$page"
        } else {
            val path = if (category == "all") "drama" else category
            "$baseUrl/$path?page=$page"
        }

        return GET(url, headers)
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()
    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ============================== 상세 정보 ==============================
    override fun animeDetailsParse(document: Document): SAnime = SAnime.create().apply {
        val titleNode = document.selectFirst("#bo_v_title .bo_v_tit, #bo_v_title h1, h1, .view-title")
        val ogTitle = document.selectFirst("meta[property='og:title']")?.attr("content")
        title = cleanSeriesTitle(ogTitle ?: titleNode?.text() ?: "티비위키")

        thumbnail_url = document.selectFirst(".poster img, .thumb img, img.cover, #bo_v_img img")?.let { img ->
            val src = img.attr("data-original").ifEmpty {
                img.attr("data-src").ifEmpty {
                    img.attr("src")
                }
            }
            fixUrl(src)
        }

        description = document.selectFirst(".thumb-desc, .desc, .summary, .content, #bo_v_con, p")?.text()?.trim()
    }

    // ============================== 회차 목록 ==============================
    override fun episodeListSelector(): String =
        "#other_list li, ul.episode-list > li, div[class*='ep'] a, a"

    override fun episodeFromElement(element: Element): SEpisode = SEpisode.create().apply {
        val link = if (element.tagName() == "a") element else element.selectFirst("a")!!
        setUrlWithoutDomain(link.attr("href"))

        val rawText = link.text().trim().ifEmpty {
            link.attr("title").ifEmpty { element.text().trim() }
        }

        name = formatEpisodeName(rawText)

        val match = Regex("(\\d+(?:\\.\\d+)?)\\s*[화회]").find(rawText)
        episode_number = match?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val currentPath = response.request.url.encodedPath.trimEnd('/')
        val episodes = ArrayList<SEpisode>()

        // 1. #other_list li 내부 링크 우선 탐색 (망가요미와 동일)
        val items = document.select("#other_list li")
        if (items.isNotEmpty()) {
            for (item in items) {
                val link = item.selectFirst("a.title.ep-link, a.title, a.ep-link, a[href]") ?: continue
                val href = link.attr("href")
                if (href.isNotBlank()) {
                    val rawName = link.attr("title").ifEmpty { link.text().ifEmpty { item.text() } }.trim()
                    val match = Regex("(\\d+(?:\\.\\d+)?)\\s*[화회]").find(rawName)
                    episodes.add(
                        SEpisode.create().apply {
                            setUrlWithoutDomain(href)
                            name = formatEpisodeName(rawName)
                            episode_number = match?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
                        },
                    )
                }
            }
        }

        // 2. 다른 레이아웃 대응
        if (episodes.isEmpty()) {
            val links = document.select("a[href]")
            for (link in links) {
                val href = link.attr("href")
                val text = link.text().trim()
                val isEpisodeUrl = href.startsWith(currentPath) && href.matches(Regex(".*/\\d+$")) && href != currentPath
                val hasEpText = text.matches(Regex(".*\\d+\\s*[화회].*"))

                if (href.isNotBlank() && (isEpisodeUrl || hasEpText)) {
                    val match = Regex("(\\d+(?:\\.\\d+)?)\\s*[화회]").find(text)
                    episodes.add(
                        SEpisode.create().apply {
                            setUrlWithoutDomain(href)
                            name = formatEpisodeName(text)
                            episode_number = match?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
                        },
                    )
                }
            }
        }

        val uniqueList = episodes.distinctBy { it.url }
        if (uniqueList.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    setUrlWithoutDomain(response.request.url.encodedPath)
                    name = "영상 재생"
                    episode_number = 1f
                },
            )
        }
        return uniqueList
    }

    // ============================== 비디오 재생 파싱 (핵심 직결) ==============================
    override fun videoListParse(response: Response): List<Video> {
        val episodePath = response.request.url.encodedPath
        val parts = episodePath.trim('/').split("/")
        if (parts.size < 3) {
            return fallbackVideoParse(response)
        }

        val boTable = parts[0]
        val wrId = parts[1]
        val epIdx = parts[2]

        // 1. 회차 메타데이터 호출 (티비위키 공식 엔드포인트)
        val metaUrl = "$baseUrl/bbs/get_episode.php?bo_table=$boTable&wr_id=$wrId&ep_idx=$epIdx"
        val metaHeaders = headersBuilder()
            .set("Referer", "$baseUrl$episodePath")
            .set("Accept", "application/json")
            .set("X-Requested-With", "XMLHttpRequest")
            .build()

        val metaResponse = client.newCall(GET(metaUrl, metaHeaders)).execute()
        val metaJson = JSONObject(metaResponse.body.string())
        if (!metaJson.optBoolean("success", false)) {
            return fallbackVideoParse(response)
        }

        val episodeObj = metaJson.getJSONObject("episode")
        val hlsUrlRel = episodeObj.optString("hls_url")
        val sessionData = episodeObj.opt("session_data1") ?: episodeObj.opt("session_data2")

        // 2. 티비위키 자체 세션 생성 호출
        var playerUrl = "$baseUrl$episodePath"
        if (sessionData != null) {
            runCatching {
                val directReqBody = sessionData.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                val directHeaders = headersBuilder()
                    .set("Referer", "$baseUrl$episodePath")
                    .set("Origin", baseUrl)
                    .set("Content-Type", "application/json; charset=utf-8")
                    .build()

                val sessionResponse = client.newCall(POST("$baseUrl/api/create_session.php", directHeaders, directReqBody)).execute()
                val sessionJson = JSONObject(sessionResponse.body.string())

                if (sessionJson.optBoolean("success", false)) {
                    val pUrl = sessionJson.optString("player_url")
                    val token = sessionJson.optString("t")
                    val sig = sessionJson.optString("sig")
                    val sep = if (pUrl.contains("?")) "&" else "?"
                    playerUrl = fixUrl(pUrl) + "${sep}t=${URLEncoder.encode(token, "UTF-8")}&sig=${URLEncoder.encode(sig, "UTF-8")}"
                }
            }
        }

        val playlistUrl = fixUrl(hlsUrlRel)

        // Aniyomi ExoPlayer용 재생 헤더
        val playHeaders = Headers.Builder()
            .add("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
            .add("Accept", "*/*")
            .add("Referer", playerUrl)
            .add("Origin", baseUrl)
            .build()

        val videoList = ArrayList<Video>()
        if (playlistUrl.isNotBlank()) {
            videoList.add(Video(playlistUrl, "고화질 스트리밍 (HLS)", playlistUrl, headers = playHeaders))
        }

        return if (videoList.isNotEmpty()) videoList else fallbackVideoParse(response)
    }

    private fun fallbackVideoParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val list = ArrayList<Video>()
        document.select("video source, video").forEach { v ->
            val src = v.attr("src")
            if (src.isNotBlank()) list.add(Video(fixUrl(src), "직접 재생", fixUrl(src)))
        }
        return list
    }

    // ============================== 헬퍼 함수 ==============================
    private fun fixUrl(url: String): String = when {
        url.startsWith("//") -> "https:$url"
        url.startsWith("/") -> "$baseUrl$url"
        else -> url
    }

    private fun cleanSeriesTitle(raw: String): String =
        raw.replace(Regex("""\s+\d+(?:[-.]\d+)?화(?:\s+다시보기)?\s*$"""), "")
            .replace(Regex("""\s+다시보기(?:\s*-\s*티비위키)?\s*$"""), "")
            .trim()

    private fun formatEpisodeName(raw: String): String {
        val trimmed = raw.trim()
        val match = Regex("""(?:^|\s)(\d+(?:[-.]\d+)?화)""").find(trimmed)
        return match?.groupValues?.get(1) ?: trimmed
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException()
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException()
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException()

    // ============================== 필터 정의 (망가요미와 일치) ==============================
    override fun getFilterList(): AnimeFilterList = AnimeFilterList(
        CategoryFilter(CATEGORIES),
        PeriodFilter(PERIODS),
        ModeFilter(MODES),
    )

    class CategoryFilter(categories: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("카테고리", categories.map { it.first }.toTypedArray())

    class PeriodFilter(periods: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("기간 (인기탭)", periods.map { it.first }.toTypedArray())

    class ModeFilter(modes: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("정렬 방식", modes.map { it.first }.toTypedArray())

    companion object {
        private val CATEGORIES = arrayOf(
            Pair("전체", "all"),
            Pair("영화", "movie"),
            Pair("한국영화", "kor_movie"),
            Pair("드라마", "drama"),
            Pair("예능프로그램", "ent"),
            Pair("시사·다큐", "sisa"),
            Pair("해외드라마", "world"),
            Pair("해외 예능·다큐", "ott_ent"),
            Pair("숏폼 드라마", "short_drama"),
            Pair("극장판 애니", "ani_movie"),
            Pair("일반 애니", "animation"),
            Pair("추억의 예능", "old_ent"),
            Pair("추억의 드라마", "old_drama"),
        )

        private val PERIODS = arrayOf(
            Pair("일간", "d"),
            Pair("주간", "w"),
            Pair("월간", "m"),
            Pair("전체 기간", "a"),
        )

        private val MODES = arrayOf(
            Pair("최신순", "latest"),
            Pair("인기순", "popular"),
        )
    }
}
