package eu.kanade.tachiyomi.animeextension.ko.livesports

import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.Jsoup

class LiveSports : AnimeHttpSource() {

    override val name = "실시간스포츠"

    override val baseUrl = "https://njtv-01.com"

    override val lang = "ko"

    override val supportsLatest = false

    // WebView 쿠키를 공유받아 처리하는 표준 클라이언트
    override val client: OkHttpClient = network.cloudflareClient

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36")
        .add("Referer", "$baseUrl/")

    // ================= 목록 (Popular / Latest) =================
    override fun popularAnimeRequest(page: Int): Request = GET(baseUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = Jsoup.parse(response.body.string())
        val animeList = mutableListOf<SAnime>()

        document.select("a[href*=/]").forEach { element ->
            val title = element.text().trim()
            val href = element.attr("abs:href")
            if (title.isNotEmpty() && href.startsWith(baseUrl)) {
                val anime = SAnime.create().apply {
                    this.title = title
                    this.setUrlWithoutDomain(href)
                    this.thumbnail_url = ""
                }
                animeList.add(anime)
            }
        }

        return AnimesPage(animeList.distinctBy { it.url }, false)
    }

    override fun latestUpdatesRequest(page: Int): Request = popularAnimeRequest(page)
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ================= 검색 =================
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request =
        GET("$baseUrl/?s=$query", headers)

    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ================= 상세 정보 =================
    override fun animeDetailsParse(response: Response): SAnime {
        return SAnime.create().apply {
            title = "실시간 경기 중계"
            status = SAnime.ONGOING
        }
    }

    // ================= 방송 회차 / 스트림 링크 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episode = SEpisode.create().apply {
            name = "실시간 스트리밍"
            episode_number = 1f
            setUrlWithoutDomain(response.request.url.toString())
        }
        return listOf(episode)
    }

    override fun videoListParse(response: Response): List<Video> {
        return emptyList()
    }

    override fun videoUrlParse(response: Response): String = ""
}
