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

    // 스포츠중계 전용 주소
    private val livePageUrl = "$baseUrl/bbs/page.php?hid=livetv_a"

    override val lang = "ko"

    override val supportsLatest = false

    override val client: OkHttpClient = network.cloudflareClient

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
    // 메인 홈 대신 스포츠중계 전용 페이지를 직접 호출
    override fun popularAnimeRequest(page: Int): Request = GET(livePageUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = Jsoup.parse(response.body.string())
        val animeList = mutableListOf<SAnime>()

        // 1. 페이지 내 iframe(플레이어) 태그 탐색
        val iframe = document.selectFirst("iframe#player, iframe[src*=xvqz.org]")
        val iframeSrc = iframe?.attr("src")

        if (!iframeSrc.isNullOrEmpty()) {
            val fullIframeUrl = if (iframeSrc.startsWith("http")) iframeSrc else "https:$iframeSrc"

            // iframe 내부의 실제 방송 목록 요청 (Referer에 njtv-01.com 동봉)
            val iframeRequest = GET(fullIframeUrl, headersBuilder().set("Referer", livePageUrl).build())
            runCatching {
                val iframeResponse = client.newCall(iframeRequest).execute()
                if (iframeResponse.isSuccessful) {
                    val iframeDoc = Jsoup.parse(iframeResponse.body.string())

                    // iframe 내 채널/경기 버튼 및 링크 추출
                    iframeDoc.select("button, a, div[onclick], li").forEach { el ->
                        val text = el.text().trim()
                        if (text.contains("ch") || text.contains("vs") || text.contains("중계") || text.contains("리그")) {
                            val anime = SAnime.create().apply {
                                this.title = text
                                // 상세 페이지 대신 해당 iframe 주소 또는 livePageUrl 사용
                                this.setUrlWithoutDomain(livePageUrl)
                                this.thumbnail_url = ""
                            }
                            animeList.add(anime)
                        }
                    }
                }
            }
        }

        // iframe 파싱에 실패하거나 목록이 비어있을 경우 기본 채널 고정 등록
        if (animeList.isEmpty()) {
            val defaultChannels = listOf("실시간 스포츠 중계 A", "실시간 스포츠 중계 B")
            defaultChannels.forEachIndexed { idx, chName ->
                val anime = SAnime.create().apply {
                    this.title = chName
                    this.setUrlWithoutDomain("/bbs/page.php?hid=livetv_${if (idx == 0) "a" else "b"}")
                    this.thumbnail_url = ""
                }
                animeList.add(anime)
            }
        }

        return AnimesPage(animeList.distinctBy { it.title }, false)
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

    // ================= 방송 회차 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episode = SEpisode.create().apply {
            name = "실시간 라이브 시청"
            episode_number = 1f
            setUrlWithoutDomain(response.request.url.toString())
        }
        return listOf(episode)
    }

    // ================= 비디오 스트림 주소 (m3u8 추출) =================
    override fun videoListParse(response: Response): List<Video> {
        val html = response.body.string()
        val videoList = mutableListOf<Video>()

        // 1. 본문 또는 iframe 내에서 m3u8 주소 직접 추출
        var m3u8Regex = """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex()
        var match = m3u8Regex.find(html)

        // 2. 만약 본문에 m3u8이 없고 iframe 태그만 있는 경우 iframe 내부 한 단계 더 탐색
        if (match == null) {
            val iframeSrc = Jsoup.parse(html).selectFirst("iframe#player, iframe[src*=xvqz.org]")?.attr("src")
            if (!iframeSrc.isNullOrEmpty()) {
                val fullIframeUrl = if (iframeSrc.startsWith("http")) iframeSrc else "https:$iframeSrc"
                val iframeReq = GET(fullIframeUrl, headersBuilder().set("Referer", response.request.url.toString()).build())
                runCatching {
                    val iframeRes = client.newCall(iframeReq).execute()
                    val iframeHtml = iframeRes.body.string()
                    match = m3u8Regex.find(iframeHtml)
                }
            }
        }

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
