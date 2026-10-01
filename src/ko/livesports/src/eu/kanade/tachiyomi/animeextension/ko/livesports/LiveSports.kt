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
import org.json.JSONArray
import org.json.JSONObject

class LiveSports : AnimeHttpSource() {

    override val name = "실시간스포츠"

    override val baseUrl = "https://njtv-01.com"

    private val livePageUrl = "$baseUrl/bbs/page.php?hid=livetv_a"
    private val iframeUrl = "https://xvqz.org/content/V28Ew6LP/modern/dark"

    override val lang = "ko"

    override val supportsLatest = false

    override val client: OkHttpClient = network.cloudflareClient

    override fun headersBuilder(): Headers.Builder = network.cloudflareClient.newBuilder().build().let {
        super.headersBuilder()
            .set("Referer", "$baseUrl/")
            .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
            .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
            .set("Sec-Ch-Ua-Mobile", "?1")
            .set("Sec-Ch-Ua-Platform", "\"Android\"")
            .set("Sec-Fetch-Dest", "document")
            .set("Sec-Fetch-Mode", "navigate")
            .set("Sec-Fetch-Site", "same-origin")
            .set("Upgrade-Insecure-Requests", "1")
    }

    // ================= 1. 종목 카테고리 =================
    override fun popularAnimeRequest(page: Int): Request = GET(livePageUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val categories = listOf(
            "실시간 인기 경기 (전체)",
            "축구 중계",
            "야구 중계",
            "농구 중계",
            "배구 중계",
            "기타 스포츠 중계"
        )

        val animeList = categories.map { catName ->
            SAnime.create().apply {
                this.title = catName
                this.setUrlWithoutDomain("/sport?cat=" + java.net.URLEncoder.encode(catName, "UTF-8"))
                this.thumbnail_url = ""
            }
        }

        return AnimesPage(animeList, false)
    }

    override fun latestUpdatesRequest(page: Int): Request = popularAnimeRequest(page)
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ================= 2. 검색 =================
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = popularAnimeRequest(1)
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ================= 3. 상세 정보 =================
    override fun animeDetailsParse(response: Response): SAnime = SAnime.create().apply {
        title = "실시간 스포츠 중계"
        status = SAnime.ONGOING
    }

    // ================= 4. 실시간 경기 목록 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episodeList = mutableListOf<SEpisode>()

        val iframeReq = GET(iframeUrl, headersBuilder().set("Referer", livePageUrl).build())
        val iframeRes = runCatching { client.newCall(iframeReq).execute() }.getOrNull()
        val iframeHtml = iframeRes?.body?.string().orEmpty()

        // 실제 감지된 index.m3u8 풀 주소 정규식 추출
        val fullM3u8Regex = """https?://[a-zA-Z0-9_\-\.]+\.kjhsdfuie\.work/live/[^"'\s\\]+index\.m3u8\?site=njtv-01\.com""".toRegex()
        val foundStreams = fullM3u8Regex.findAll(iframeHtml).map { it.value }.toSet()

        var count = 1f
        for (m3u8Url in foundStreams) {
            episodeList.add(
                SEpisode.create().apply {
                    this.name = "실시간 라이브 채널 $count"
                    this.episode_number = count++
                    this.url = "/play?stream_url=" + java.net.URLEncoder.encode(m3u8Url, "UTF-8")
                }
            )
        }

        // 탐색되지 않았을 경우 1DM 패킷에서 확인된 정확한 주소 규격 적용
        if (episodeList.isEmpty()) {
            val livePathRegex = """live/([0-9]+)/([a-zA-Z0-9]+)""".toRegex()
            val match = livePathRegex.find(iframeHtml)
            val channelId = match?.groupValues?.get(1) ?: "131"
            val token = match?.groupValues?.get(2) ?: "56ad7640b9ad"

            val targetUrl = "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$channelId/$token/index.m3u8?site=njtv-01.com"

            episodeList.add(
                SEpisode.create().apply {
                    this.name = "실시간 라이브 중계 (농구/실시간)"
                    this.episode_number = 1f
                    this.url = "/play?stream_url=" + java.net.URLEncoder.encode(targetUrl, "UTF-8")
                }
            )
        }

        return episodeList
    }

    // ================= 5. 비디오 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val encodedUrl = response.request.url.queryParameter("stream_url")
        val playUrl = if (!encodedUrl.isNullOrEmpty()) {
            java.net.URLDecoder.decode(encodedUrl, "UTF-8")
        } else {
            "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/131/56ad7640b9ad/index.m3u8?site=njtv-01.com"
        }

        // 1DM 패킷과 동일한 클린 헤더 구성
        val mediaHeaders = Headers.Builder()
            .set("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
            .set("Referer", "$baseUrl/")
            .set("Origin", baseUrl)
            .set("Accept", "*/*")
            .build()

        return listOf(
            Video(playUrl, "실시간 라이브 스트림", playUrl, mediaHeaders)
        )
    }

    override fun videoUrlParse(response: Response): String = ""
}
