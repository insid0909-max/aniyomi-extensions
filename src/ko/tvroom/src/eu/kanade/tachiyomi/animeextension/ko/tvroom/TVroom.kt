package eu.kanade.tachiyomi.animeextension.ko.tvroom

import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.ParsedAnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

class TVroom : ParsedAnimeHttpSource() {

    override val name = "영화"
    override val baseUrl = "https://tvwiki51.net"
    override val lang = "ko"
    override val supportsLatest = true

    override val client: OkHttpClient = network.client

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .add("Referer", baseUrl)

    // ============================== 인기 목록 ==============================
    override fun popularAnimeRequest(page: Int): Request =
        GET("$baseUrl/popular?page=$page", headers)

    override fun popularAnimeSelector(): String =
        "div[class*='col'], div[class*='item'], div.card, a[href~=^/(movie|kor_movie|ani_movie|drama|ent)/\\d+]"

    override fun popularAnimeFromElement(element: Element): SAnime = SAnime.create().apply {
        val link = if (element.tagName() == "a") element else element.selectFirst("a")!!
        setUrlWithoutDomain(link.attr("href"))

        val img = element.selectFirst("img")
        title = element.selectFirst("h1, h2, h3, h4, h5, .title, .subject, .name")?.text()?.trim()
            ?: img?.attr("alt")?.trim()?.ifEmpty { null }
            ?: link.attr("title").trim().ifEmpty { null }
            ?: link.text().trim().ifEmpty { "제목 없음" }

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
        val animeList = document.select(popularAnimeSelector())
            .mapNotNull { runCatching { popularAnimeFromElement(it) }.getOrNull() }
            .filter { it.url.isNotBlank() }
            .distinctBy { it.url }

        val hasNextPage = popularAnimeNextPageSelector()?.let { document.selectFirst(it) } != null
        return AnimesPage(animeList, hasNextPage)
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
            return GET("$baseUrl/search?q=$query&page=$page", headers)
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
    override fun episodeListSelector(): String =
        "a[href*='/view/'], a[href*='/watch/'], a[href*='/episode/'], div:has(> a[href*='view']) a, div[class*='ep'] a, a:has(span, h4, h5, p)"

    override fun episodeFromElement(element: Element): SEpisode = SEpisode.create().apply {
        val link = if (element.tagName() == "a") element else element.selectFirst("a") ?: element
        setUrlWithoutDomain(link.attr("href"))

        val epTitle = link.text().trim().ifEmpty {
            link.attr("title").ifEmpty { "1화" }
        }
        name = epTitle

        val epMatch = Regex("(\\d+)\\s*화").find(epTitle)
        episode_number = epMatch?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val episodes = document.select(episodeListSelector())
            .filter { it.attr("href").isNotBlank() }
            .map { episodeFromElement(it) }
            .distinctBy { it.url }

        if (episodes.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    setUrlWithoutDomain(response.request.url.encodedPath)
                    name = "영화 재생"
                    episode_number = 1f
                },
            )
        }
        return episodes
    }

    // ============================== 비디오 재생 파싱 ==============================
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()

        document.select("iframe").forEach { iframe ->
            val src = iframe.attr("src")
            if (src.isNotBlank() && !src.contains("ads") && !src.contains("banner")) {
                val streamUrl = if (src.startsWith("//")) "https:$src" else src
                videoList.add(Video(streamUrl, "스트리밍 서버", streamUrl))
            }
        }

        document.select("video source, video").forEach { video ->
            val src = video.attr("src")
            if (src.isNotBlank()) {
                val streamUrl = if (src.startsWith("//")) "https:$src" else src
                videoList.add(Video(streamUrl, "직접 재생", streamUrl))
            }
        }

        return videoList
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
            Pair("영화 (전체)", "movie"),
            Pair("한국 영화", "kor_movie"),
            Pair("극장판 애니", "ani_movie"),
            Pair("예능", "ent"),
            Pair("드라마", "drama"),
        )

        private val ORDERS = arrayOf(
            Pair("시간순", "time"),
            Pair("인기순", "popular"),
        )
    }
}
