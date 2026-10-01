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

    // WebView의 세션 쿠키를 동기화하여 사용하는 Aniyomi 표준 클라이언트
    override val client: OkHttpClient = network.cloudflareClient

    // 기기 WebView와 동일한 고유 지문 및 헤더 유지
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

        // 사이트 내 경기/채널 링크 수집
        document.select("a[href*=/]").forEach { element ->
            val title = element.text().trim()
            val href = element.attr("abs:href")

            // 기본 필터링 (너무 짧거나 불필요한 링크 제외)
            if (title.isNotEmpty() && href.startsWith(baseUrl) && title.length > 2) {
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

    // ================= 회차 목록 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episode = SEpisode.create().apply {
            name = "실시간 라이브"
            episode_number = 1f
            setUrlWithoutDomain(response.request.url.toString())
        }
        return listOf(episode)
    }

    // ================= 비디오 스트림 주소 (m3u8 추출) =================
    override fun videoListParse(response: Response): List<Video> {
        val html = response.body.string()
        val videoList = mutableListOf<Video>()

        // HTML 본문 또는 스크립트에 포함된 m3u8 주소 추출 (정규식 탐색)
        val m3u8Regex = """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex()
        val match = m3u8Regex.find(html)

        val streamUrl = match?.value

        if (!streamUrl.isNullOrEmpty()) {
            val videoHeaders = headersBuilder()
                .set("Referer", "$baseUrl/")
                .set("Origin", baseUrl)
                .build()

            videoList.add(Video(streamUrl, "실시간 중계 (HLS)", streamUrl, videoHeaders))
        }

        return videoList
    }

    override fun videoUrlParse(response: Response): String = ""
}
