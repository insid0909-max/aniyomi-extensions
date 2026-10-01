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

    // WebView의 세션 쿠키를 동기화하는 클라이언트
    override val client: OkHttpClient = network.cloudflareClient

    // 시스템 기본 헤더 기반으로 실 브라우저 헤더 주입
    override fun headersBuilder(): Headers.Builder = network.cloudflareClient.newBuilder().build().let {
        super.headersBuilder()
            .set("Referer", "$baseUrl/")
            .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
            .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
            .set("Sec-Ch-Ua-Mobile", "?1")
            .set("Sec-Ch-Ua-Platform", "\"Android\"")
            .set("Sec-Fetch-Dest", "document")
            .set("Sec-Fetch-Mode", "navigate")
            .set("Sec-Fetch-Site", "same-origin")
            .set("Sec-Fetch-User", "?1")
            .set("Upgrade-Insecure-Requests", "1")
    }

    // ================= 목록 (Popular / Latest) =================
    override fun popularAnimeRequest(page: Int): Request = GET(baseUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = Jsoup.parse(response.body.string())
        val animeList = mutableListOf<SAnime>()

        // 방송 중인 채널 및 경기 파싱
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
