package eu.kanade.tachiyomi.animeextension.ko.tvroom

import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.ParsedAnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

class TVroom : ParsedAnimeHttpSource() {

    override val name = "영화"

    // [유지보수] 사이트 도메인이 바뀌면 이 주소만 수정하고 커밋하면 됩니다.
    override val baseUrl = "https://tvwiki51.net"

    override val lang = "ko"

    override val supportsLatest = true

    override val client: OkHttpClient = network.client

    // ================= 인기 / 최신 목록 =================
    override fun popularAnimeRequest(page: Int): Request = GET("$baseUrl/movie/page/$page")

    override fun popularAnimeSelector(): String = "ul.post-list li, div.item"

    override fun popularAnimeFromElement(element: Element): SAnime = SAnime.create().apply {
        title = element.select("span.title, a.title").text()
        thumbnail_url = element.select("img").attr("abs:src")
        setUrlWithoutDomain(element.select("a").first()?.attr("href").orEmpty())
    }

    override fun popularAnimeNextPageSelector(): String = "a.next, .pagination-next"

    override fun latestUpdatesRequest(page: Int): Request = GET("$baseUrl/movie/page/$page")

    override fun latestUpdatesSelector(): String = popularAnimeSelector()

    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun latestUpdatesNextPageSelector(): String = popularAnimeNextPageSelector()

    // ================= 검색 =================
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request =
        GET("$baseUrl/search?q=$query&page=$page")

    override fun searchAnimeSelector(): String = popularAnimeSelector()

    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun searchAnimeNextPageSelector(): String = popularAnimeNextPageSelector()

    // ================= 상세 페이지 =================
    override fun animeDetailsParse(document: Document): SAnime = SAnime.create().apply {
        title = document.select("h1.entry-title, .title").text()
        description = document.select(".description, .entry-content").text()
        genre = document.select(".genres a").joinToString(", ") { it.text() }
        status = SAnime.UNKNOWN
    }

    // ================= 회차 목록 =================
    override fun episodeListSelector(): String = "ul.episodes li a, .episode-list a"

    override fun episodeFromElement(element: Element): SEpisode = SEpisode.create().apply {
        name = element.text()
        setUrlWithoutDomain(element.attr("href"))
    }

    // ================= 비디오 주소 추출 =================
    override fun videoListParse(response: Response): List<Video> {
        val bodyString = response.body?.string().orEmpty()
        val document = Jsoup.parse(bodyString)
        val videoList = mutableListOf<Video>()
        val iframeUrl = document.select("iframe").attr("abs:src")
        if (iframeUrl.isNotEmpty()) {
            videoList.add(Video(iframeUrl, "기본 서버", iframeUrl))
        }
        return videoList
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")
}
