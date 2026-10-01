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
import org.jsoup.Jsoup

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

    private fun iframeHeaders(): Headers = headersBuilder()
        .set("Referer", iframeUrl)
        .set("Origin", "https://xvqz.org")
        .set("Accept", "*/*")
        .build()

    // ================= 1. 종목 카테고리 (Anime Page) =================
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

    // ================= 4. 실시간 경기 목록 (SEpisode) =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episodeList = mutableListOf<SEpisode>()

        // iframe 내부 소스 호출
        val iframeReq = GET(iframeUrl, headersBuilder().set("Referer", livePageUrl).build())
        val iframeRes = runCatching { client.newCall(iframeReq).execute() }.getOrNull()
        val iframeHtml = iframeRes?.body?.string().orEmpty()

        // 1) 내부 JSON API 주소 동적 탐색 (v8ca...xvqz.org/data/iframe-streams.json 등)
        val jsonApiRegex = """https?://[a-zA-Z0-9_\-\.]+\.xvqz\.org/data/iframe-streams\.json""".toRegex()
        val jsonApiUrl = jsonApiRegex.find(iframeHtml)?.value

        if (!jsonApiUrl.isNullOrEmpty()) {
            val apiReq = GET(jsonApiUrl, iframeHeaders())
            runCatching {
                val apiRes = client.newCall(apiReq).execute()
                val jsonStr = apiRes.body.string()
                val root = if (jsonStr.trim().startsWith("[")) JSONArray(jsonStr) else JSONObject(jsonStr).optJSONArray("streams") ?: JSONArray()
                
                var count = 1f
                for (i in 0 until root.length()) {
                    val item = root.optJSONObject(i) ?: continue
                    val name = item.optString("name", item.optString("title", item.optString("match", "라이브 채널 $i"))).trim()
                    val key = item.optString("stream", item.optString("key", item.optString("id", ""))).trim()

                    if (key.isNotEmpty()) {
                        episodeList.add(
                            SEpisode.create().apply {
                                this.name = name
                                this.episode_number = count++
                                this.url = "/play?key=$key"
                            }
                        )
                    }
                }
            }
        }

        // 2) JSON 파싱에 실패했거나 비어있는 경우 HTML 내부에서 활성 스트림 키 자동 포획
        if (episodeList.isEmpty()) {
            val keyRegex = """(?:/live/|streamKey["']?\s*[:=]\s*["'])([a-zA-Z0-9_\-]{8,25})""".toRegex()
            val capturedKey = keyRegex.find(iframeHtml)?.groupValues?.get(1) ?: "gWsOolRJHgz"

            episodeList.add(
                SEpisode.create().apply {
                    this.name = "실시간 라이브 채널 1"
                    this.episode_number = 1f
                    this.url = "/play?key=$capturedKey"
                }
            )
            episodeList.add(
                SEpisode.create().apply {
                    this.name = "실시간 라이브 채널 2"
                    this.episode_number = 2f
                    this.url = "/play?key=$capturedKey"
                }
            )
        }

        return episodeList
    }

    // ================= 5. 스트림 미디어 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val streamKey = response.request.url.queryParameter("key") ?: "gWsOolRJHgz"
        val videoList = mutableListOf<Video>()

        // CDN 전용 필수 헤더
        val mediaHeaders = Headers.Builder()
            .set("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
            .set("Referer", "$baseUrl/")
            .set("Origin", baseUrl)
            .set("Accept", "*/*")
            .build()

        // 1번 메인 서버 (daxnb7e8nd4e0hdj)
        val server1 = "https://daxnb7e8nd4e0hdj.kjhsdfuie.work/live/$streamKey/playlist.m3u8?site=njtv-01.com"
        videoList.add(Video(server1, "메인 고화질 서버", server1, mediaHeaders))

        // 2번 미러 서버 (ol3ktizakokhjhnu)
        val server2 = "https://ol3ktizakokhjhnu.kjhsdfuie.work/live/$streamKey/playlist.m3u8?site=njtv-01.com"
        videoList.add(Video(server2, "보조 백업 서버", server2, mediaHeaders))

        return videoList
    }

    override fun videoUrlParse(response: Response): String = ""
}
