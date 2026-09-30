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

    override val client: OkHttpClient = network.client

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
        .add("Referer", "$baseUrl/")

    // 1. 메인 목록: 실시간 스포츠 진입 카드 노출
    override fun popularAnimeRequest(page: Int): Request = GET("$baseUrl/bbs/page.php?hid=livetv_a", headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val animeList = mutableListOf<SAnime>()

        val liveEntry = SAnime.create().apply {
            title = "실시간 스포츠 라이브 중계"
            url = "/bbs/page.php?hid=livetv_a"
            thumbnail_url = "$baseUrl/data/apms/background/logo.png"
            status = SAnime.ONGOING
        }
        animeList.add(liveEntry)

        return AnimesPage(animeList, false)
    }

    override fun latestUpdatesRequest(page: Int): Request = popularAnimeRequest(page)
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    // 2. 상세 정보
    override fun animeDetailsParse(response: Response): SAnime {
        return SAnime.create().apply {
            title = "실시간 스포츠 라이브 중계"
            description = "실시간 스포츠 경기 라이브 스트리밍"
            genre = "Sports, Live"
            status = SAnime.ONGOING
        }
    }

    // 3. 경기 목록 (에피소드): iframe 링크 파싱
    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = Jsoup.parse(response.body.string())
        val iframeSrc = document.select("iframe#player").attr("abs:src")

        val episodes = mutableListOf<SEpisode>()

        if (iframeSrc.isNotEmpty()) {
            val ep = SEpisode.create().apply {
                name = "현재 실시간 방송 시청"
                url = iframeSrc
                episode_number = 1f
            }
            episodes.add(ep)
        }

        return episodes
    }

    // 4. 비디오 스트림 주소 반환 (HLS m3u8)
    override fun videoListParse(response: Response): List<Video> {
        val html = response.body.string()
        val videoList = mutableListOf<Video>()

        val m3u8Regex = """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex()
        val match = m3u8Regex.find(html)

        val streamHeaders = Headers.Builder()
            .set("Referer", "$baseUrl/")
            .set("User-Agent", headers["User-Agent"]!!)
            .build()

        if (match != null) {
            val url = match.value
            videoList.add(Video(url, "실시간 라이브 스트림", url, headers = streamHeaders))
        }

        return videoList
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = popularAnimeRequest(page)
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)
}
