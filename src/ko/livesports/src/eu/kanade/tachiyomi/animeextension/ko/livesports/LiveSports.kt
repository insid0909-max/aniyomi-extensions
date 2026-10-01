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
    private val streamJsonUrl = "https://v8ca6dfp7jzt47dx.xvqz.org/data/iframe-streams.json"

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
        .set("Accept", "application/json, text/plain, */*")
        .set("Sec-Fetch-Dest", "empty")
        .set("Sec-Fetch-Mode", "cors")
        .set("Sec-Fetch-Site", "same-site")
        .build()

    // ================= 1. 종목 목록 (Anime Page) =================
    override fun popularAnimeRequest(page: Int): Request = GET(streamJsonUrl, iframeHeaders())

    override fun popularAnimeParse(response: Response): AnimesPage {
        val bodyStr = response.body.string()
        val sportsSet = LinkedHashSet<String>()

        runCatching {
            val root = if (bodyStr.trim().startsWith("[")) JSONArray(bodyStr) else JSONObject(bodyStr).optJSONArray("streams") ?: JSONArray()
            for (i in 0 until root.length()) {
                val item = root.optJSONObject(i) ?: continue
                val sport = item.optString("sport", item.optString("category", item.optString("type", ""))).trim()
                if (sport.isNotEmpty()) {
                    sportsSet.add(sport)
                }
            }
        }

        if (sportsSet.isEmpty()) {
            sportsSet.addAll(listOf("전체 경기 중계", "야구", "축구", "농구", "기타 중계"))
        }

        val animeList = sportsSet.map { sportName ->
            SAnime.create().apply {
                this.title = sportName
                this.setUrlWithoutDomain("/sport?name=" + java.net.URLEncoder.encode(sportName, "UTF-8"))
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

    // ================= 3. 종목 상세 =================
    override fun animeDetailsParse(response: Response): SAnime = SAnime.create().apply {
        title = "실시간 경기 중계"
        status = SAnime.ONGOING
    }

    // ================= 4. 경기 목록 (SEpisode) =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val targetSport = response.request.url.queryParameter("name") ?: ""
        val jsonReq = GET(streamJsonUrl, iframeHeaders())
        val episodeList = mutableListOf<SEpisode>()

        runCatching {
            val jsonRes = client.newCall(jsonReq).execute()
            val bodyStr = jsonRes.body.string()
            val root = if (bodyStr.trim().startsWith("[")) JSONArray(bodyStr) else JSONObject(bodyStr).optJSONArray("streams") ?: JSONArray()
            var count = 1f

            for (i in 0 until root.length()) {
                val item = root.optJSONObject(i) ?: continue
                val sport = item.optString("sport", item.optString("category", item.optString("type", ""))).trim()

                if (targetSport.isNotEmpty() && !targetSport.contains("전체") && sport.isNotEmpty() && !sport.contains(targetSport, true)) {
                    continue
                }

                val title = item.optString("name", item.optString("title", item.optString("match", "라이브 채널 $i"))).trim()
                val streamKey = item.optString("stream", item.optString("key", item.optString("id", item.optString("file", "")))).trim()
                val directUrl = item.optString("url", item.optString("m3u8", "")).trim()

                val playTarget = when {
                    directUrl.isNotEmpty() -> directUrl
                    streamKey.isNotEmpty() -> "https://daxnb7e8nd4e0hdj.kjhsdfuie.work/live/$streamKey/playlist.m3u8?site=njtv-01.com"
                    else -> ""
                }

                if (playTarget.isNotEmpty()) {
                    episodeList.add(
                        SEpisode.create().apply {
                            this.name = if (sport.isNotEmpty()) "[$sport] $title" else title
                            this.episode_number = count++
                            this.url = "/live_stream?play_url=" + java.net.URLEncoder.encode(playTarget, "UTF-8")
                        }
                    )
                }
            }
        }

        if (episodeList.isEmpty()) {
            val defaultStream = "https://daxnb7e8nd4e0hdj.kjhsdfuie.work/live/NAU9HRalA2x/playlist.m3u8?site=njtv-01.com"
            episodeList.add(
                SEpisode.create().apply {
                    this.name = "실시간 활성 라이브 (기본 채널)"
                    this.episode_number = 1f
                    this.url = "/live_stream?play_url=" + java.net.URLEncoder.encode(defaultStream, "UTF-8")
                }
            )
        }

        return episodeList
    }

    // ================= 5. 스트림 URL 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val encodedUrl = response.request.url.queryParameter("play_url")
        val playUrl = if (!encodedUrl.isNullOrEmpty()) {
            java.net.URLDecoder.decode(encodedUrl, "UTF-8")
        } else {
            "https://daxnb7e8nd4e0hdj.kjhsdfuie.work/live/NAU9HRalA2x/playlist.m3u8?site=njtv-01.com"
        }

        // 미디어 CDN 서버 전용 클린 헤더
        val cleanMediaHeaders = Headers.Builder()
            .set("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
            .set("Referer", "$baseUrl/")
            .set("Origin", baseUrl)
            .set("Accept", "*/*")
            .build()

        return listOf(Video(playUrl, "실시간 고화질 중계", playUrl, cleanMediaHeaders))
    }

    override fun videoUrlParse(response: Response): String = ""
}
