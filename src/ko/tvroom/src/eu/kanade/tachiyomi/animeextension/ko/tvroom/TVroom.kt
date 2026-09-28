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
import java.util.Base64

class TVroom : ParsedAnimeHttpSource() {

    override val name = "영화"
    override val baseUrl = "https://tvwiki51.net"
    override val lang = "ko"
    override val supportsLatest = true

    private val bridgeBaseUrl = "https://dc-toki-mangayomi-media.pages.dev"
    override val client: OkHttpClient = network.client

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
        .add("Referer", "$baseUrl/")

    // ============================== 인기 목록 ==============================
    override fun popularAnimeRequest(page: Int): Request =
        GET("$baseUrl/popular?page=$page", headers)

    override fun popularAnimeSelector(): String = "a:has(img)"

    override fun popularAnimeFromElement(element: Element): SAnime = SAnime.create().apply {
        setUrlWithoutDomain(element.attr("href"))

        val img = element.selectFirst("img")
        val parent = element.parent()
        title = img?.attr("alt")?.trim()?.ifEmpty { null }
            ?: element.attr("title").trim().ifEmpty { null }
            ?: parent?.selectFirst("h1, h2, h3, h4, h5, p, span, div:not(:has(*))")?.text()?.trim()?.ifEmpty { null }
            ?: element.text().trim().ifEmpty { "제목 없음" }

        thumbnail_url = img?.let {
            val src = it.attr("data-src").ifEmpty {
                it.attr("data-original").ifEmpty {
                    it.attr("src")
                }
            }
            when {
                src.startsWith("//") -> "https:$src"
                src.startsWith("/") -> "$baseUrl$src"
                else -> src
            }
        }
    }

    override fun popularAnimeNextPageSelector(): String? =
        "a:contains(다음), a.next, a[rel=next], .pagination .active + li a"

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = response.asJsoup()
        val elements = document.select(popularAnimeSelector())
        val animeList = ArrayList<SAnime>()

        for (el in elements) {
            val href = el.attr("href")
            if (href.matches(Regex(".*/(movie|kor_movie|drama|ent|ani|foreign_drama|docu)/\\d+.*"))) {
                runCatching {
                    val anime = popularAnimeFromElement(el)
                    if (anime.url.isNotBlank() && !anime.url.contains("notice")) {
                        animeList.add(anime)
                    }
                }
            }
        }

        val uniqueList = animeList.distinctBy { it.url }
        val hasNextPage = popularAnimeNextPageSelector()?.let { document.selectFirst(it) } != null
        return AnimesPage(uniqueList, hasNextPage)
    }

    // ============================== 최신 목록 ==============================
    override fun latestUpdatesRequest(page: Int): Request =
        GET("$baseUrl/movie?page=$page", headers)

    override fun latestUpdatesSelector(): String = popularAnimeSelector()
    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ============================== 검색 및 필터 ==============================
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        if (query.isNotBlank()) {
            return GET("$baseUrl/search?stx=${URLEncoder.encode(query, "UTF-8")}&page=$page", headers)
        }

        var category = "popular"
        var order = "time"

        filters.forEach { filter ->
            when (filter) {
                is CategoryFilter -> category = CATEGORIES[filter.state].second
                is OrderFilter -> order = ORDERS[filter.state].second
                else -> {}
            }
        }

        val url = if (order == "popular") {
            "$baseUrl/$category?order=popular&page=$page"
        } else {
            "$baseUrl/$category?page=$page"
        }

        return GET(url, headers)
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()
    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ============================== 상세 정보 ==============================
    override fun animeDetailsParse(document: Document): SAnime = SAnime.create().apply {
        title = document.selectFirst("h1, .view-title, .title")?.text()?.trim() ?: "제목 없음"
        thumbnail_url = document.selectFirst(".poster img, .thumb img, img.cover, img")?.let { img ->
            val src = img.attr("data-src").ifEmpty { img.attr("src") }
            if (src.startsWith("//")) "https:$src" else if (src.startsWith("/")) "$baseUrl$src" else src
        }
        description = document.selectFirst(".desc, .summary, .content, .synopsis, p")?.text()?.trim()
    }

    // ============================== 회차(에피소드) 목록 ==============================
    override fun episodeListSelector(): String = "a"

    override fun episodeFromElement(element: Element): SEpisode = SEpisode.create().apply {
        val link = if (element.tagName() == "a") element else element.selectFirst("a") ?: element
        setUrlWithoutDomain(link.attr("href"))

        val epTitle = link.text().trim().ifEmpty {
            link.attr("title").ifEmpty { "1화" }
        }
        name = epTitle

        val epMatch = Regex("(\\d+)\\s*[화회]").find(epTitle)
        episode_number = epMatch?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val currentPath = response.request.url.encodedPath.trimEnd('/')
        val elements = document.select("a")
        val episodes = ArrayList<SEpisode>()

        for (el in elements) {
            val href = el.attr("href")
            val text = el.text().trim()

            val isEpisodeUrl = href.startsWith(currentPath) && href.matches(Regex(".*/\\d+$")) && href != currentPath
            val hasEpisodeText = text.matches(Regex(".*\\d+\\s*[화회].*"))

            if (href.isNotBlank() && (isEpisodeUrl || hasEpisodeText)) {
                val title = text.ifEmpty { el.attr("title").ifEmpty { "회차 재생" } }
                val match = Regex("(\\d+)\\s*[화회]").find(title)
                val epNum = match?.groupValues?.get(1)?.toFloatOrNull() ?: 1f

                episodes.add(
                    SEpisode.create().apply {
                        setUrlWithoutDomain(href)
                        name = title
                        episode_number = epNum
                    },
                )
            }
        }

        val uniqueEpisodes = episodes.distinctBy { it.url }

        if (uniqueEpisodes.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    setUrlWithoutDomain(response.request.url.encodedPath)
                    name = "영상 재생"
                    episode_number = 1f
                },
            )
        }
        return uniqueEpisodes
    }

    // ============================== 비디오 재생 파싱 (핵심: 망가요미 알고리즘 이식) ==============================
    override fun videoListParse(response: Response): List<Video> {
        val episodePath = response.request.url.encodedPath
        val parts = episodePath.trim('/').split("/")
        if (parts.size < 3) {
            return fallbackVideoParse(response)
        }

        val boTable = parts[0]
        val wrId = parts[1]
        val epIdx = parts[2]

        // 1. 회차 메타데이터 요청
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
        val sessionData1 = episodeObj.opt("session_data1")
        val sessionData2 = episodeObj.opt("session_data2")

        val payload = sessionData1 ?: sessionData2 ?: return fallbackVideoParse(response)

        // 2. 재생 세션 요청 (Mangayomi Bridge API)
        val bridgeUrl = "$bridgeBaseUrl/api/tvwiki-session"
        val bridgeReqBody = JSONObject().apply {
            put("baseUrl", baseUrl)
            put("episodePath", episodePath)
            put("sessionData", payload)
        }.toString().toRequestBody("application/json; charset=utf-8".toMediaType())

        val bridgeHeaders = headersBuilder()
            .set("Referer", "$bridgeBaseUrl/")
            .set("Content-Type", "application/json; charset=utf-8")
            .build()

        val sessionResponse = client.newCall(POST(bridgeUrl, bridgeHeaders, bridgeReqBody)).execute()
        val sessionJson = JSONObject(sessionResponse.body.string())

        val playerUrlPart = sessionJson.optString("player_url")
        val token = sessionJson.optString("t")
        val sig = sessionJson.optString("sig")

        val sep = if (playerUrlPart.contains("?")) "&" else "?"
        val fullPlayerUrl = fixUrl(playerUrlPart) + "${sep}t=${URLEncoder.encode(token, "UTF-8")}&sig=${URLEncoder.encode(sig, "UTF-8")}"
        val playlistUrl = fixUrl(hlsUrlRel)

        val playHeaders = Headers.Builder()
            .add("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
            .add("Accept", "*/*")
            .add("Referer", fullPlayerUrl)
            .add("Origin", baseUrl)
            .build()

        // 3. Playlist 요청 및 암호화 키 확인
        val plResponse = client.newCall(GET(playlistUrl, playHeaders)).execute()
        val plBody = plResponse.body.string()

        val keyMatch = Regex("""#EXT-X-KEY:[^\r\n]*URI="([^"]+)"""", RegexOption.IGNORE_CASE).find(plBody)
        if (keyMatch == null) {
            return listOf(Video(playlistUrl, "자동 (HLS)", playlistUrl, headers = playHeaders))
        }

        val keyUri = keyMatch.groupValues[1]
        val fullKeyUrl = if (keyUri.startsWith("http")) keyUri else playlistUrl.substringBeforeLast("/") + "/" + keyUri
        val keyResponse = client.newCall(GET(fullKeyUrl, playHeaders)).execute()
        val envelope = keyResponse.body.string()

        val uEnc = URLEncoder.encode(base64Url(playlistUrl), "UTF-8")
        val rEnc = URLEncoder.encode(base64Url(fullPlayerUrl), "UTF-8")
        val xEnc = URLEncoder.encode(base64Url(envelope), "UTF-8")
        val common = "u=$uEnc&r=$rEnc&x=$xEnc"

        return listOf(
            Video("$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common", "빠른 재생 (CDN 직접)", "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common", headers = playHeaders),
            Video("$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common", "호환 재생 (중계)", "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common", headers = playHeaders),
        )
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

    private fun base64Url(str: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(str.toByteArray(Charsets.UTF_8))

    private fun fixUrl(url: String): String = when {
        url.startsWith("//") -> "https:$url"
        url.startsWith("/") -> "$baseUrl$url"
        else -> url
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException()
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException()
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException()

    // ============================== 필터 정의 ==============================
    override fun getFilterList(): AnimeFilterList = AnimeFilterList(
        CategoryFilter(CATEGORIES),
        OrderFilter(ORDERS),
    )

    class CategoryFilter(categories: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("카테고리", categories.map { it.first }.toTypedArray())

    class OrderFilter(orders: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("정렬", orders.map { it.first }.toTypedArray())

    companion object {
        private val CATEGORIES = arrayOf(
            Pair("인기 자료", "popular"),
            Pair("영화", "movie"),
            Pair("한국영화", "kor_movie"),
            Pair("드라마", "drama"),
            Pair("예능프로그램", "ent"),
            Pair("해외드라마", "foreign_drama"),
            Pair("시사/다큐", "docu"),
        )

        private val ORDERS = arrayOf(
            Pair("시간순", "time"),
            Pair("인기순", "popular"),
        )
    }
}
