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
    override val lang = "ko"
    override val supportsLatest = false

    private val livePageUrl = "$baseUrl/bbs/page.php?hid=livetv_a"
    private val iframeUrl = "https://xvqz.org/content/V28Ew6LP/modern/dark"

    override val client: OkHttpClient = network.cloudflareClient

    // 메인 페이지 접근용 헤더
    override fun headersBuilder(): Headers.Builder = network.cloudflareClient.newBuilder().build().let {
        super.headersBuilder()
            .set("Referer", "$baseUrl/")
            .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
            .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
            .set("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
    }

    // JSON API 및 iframe 접근용 위장 헤더 (빈 화면 차단 우회)
    private fun apiHeaders(): Headers = headersBuilder()
        .set("Referer", "https://xvqz.org/")
        .set("Origin", "https://xvqz.org")
        .set("Accept", "application/json, text/plain, */*")
        .build()

    // ================= 1. 종목 카테고리 =================
    override fun popularAnimeRequest(page: Int): Request = GET(livePageUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val categories = listOf("전체 경기", "축구", "야구", "농구", "배구", "기타")
        val animeList = categories.map { catName ->
            SAnime.create().apply {
                this.title = catName
                this.setUrlWithoutDomain("/sport?cat=" + java.net.URLEncoder.encode(catName, "UTF-8"))
            }
        }
        return AnimesPage(animeList, false)
    }

    override fun latestUpdatesRequest(page: Int): Request = popularAnimeRequest(page)
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = popularAnimeRequest(1)
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ================= 2. 상세 정보 =================
    override fun animeDetailsParse(response: Response): SAnime = SAnime.create().apply {
        title = "실시간 스포츠 중계"
        status = SAnime.ONGOING
    }

    // ================= 3. 실시간 경기 목록 및 JSON 파싱 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episodeList = mutableListOf<SEpisode>()

        // 1. iframe HTML 요청
        val iframeReq = GET(iframeUrl, headersBuilder().set("Referer", livePageUrl).build())
        val iframeHtml = runCatching { client.newCall(iframeReq).execute().body?.string() }.getOrNull().orEmpty()

        // 2. 동적 JSON URL 추출 (예: v8ca6dfp7jzt47dx.xvqz.org/data/iframe-streams.json)
        val jsonUrlRegex = """https?://[a-zA-Z0-9_\-\.]+\.xvqz\.org/data/iframe-streams\.json""".toRegex()
        val jsonUrl = jsonUrlRegex.find(iframeHtml)?.value

        // 3. JSON 데이터 요청 및 파싱
        if (!jsonUrl.isNullOrEmpty()) {
            val apiReq = GET(jsonUrl, apiHeaders()) // Referer 위장 헤더 필수
            val apiRes = runCatching { client.newCall(apiReq).execute().body?.string() }.getOrNull().orEmpty()

            if (apiRes.isNotBlank()) {
                try {
                    // 응답이 배열([])인지 객체({})인지 확인 후 파싱
                    val jsonArray = if (apiRes.trim().startsWith("[")) {
                        JSONArray(apiRes)
                    } else {
                        JSONObject(apiRes).optJSONArray("streams") ?: JSONArray()
                    }

                    var count = 1f
                    for (i in 0 until jsonArray.length()) {
                        val item = jsonArray.optJSONObject(i) ?: continue
                        
                        // JSON 구조 대응 (name/title/match, url/stream/key 등)
                        val name = item.optString("name", item.optString("title", "실시간 경기 $count"))
                        val url = item.optString("url", item.optString("stream", item.optString("key", "")))

                        if (url.isNotEmpty()) {
                            episodeList.add(
                                SEpisode.create().apply {
                                    this.name = name
                                    this.episode_number = count++
                                    // URL이 전체 주소인지, 131/56ad7640b9ad 같은 토큰인지 구분하여 넘김
                                    this.url = "/play?stream_data=" + java.net.URLEncoder.encode(url, "UTF-8")
                                }
                            )
                        }
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }

        // 4. JSON 파싱 실패 시, 이전에 패킷으로 확인된 규격 기반 Fallback
        if (episodeList.isEmpty()) {
            // 패킷에서 확인된 채널ID와 토큰 정규식 추출
            val livePathRegex = """live/([0-9]+)/([a-zA-Z0-9]+)""".toRegex()
            val match = livePathRegex.find(iframeHtml)
            val channelId = match?.groupValues?.get(1) ?: "131"
            val token = match?.groupValues?.get(2) ?: "56ad7640b9ad"
            
            val fallbackUrl = "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$channelId/$token/index.m3u8?site=njtv-01.com"

            episodeList.add(
                SEpisode.create().apply {
                    this.name = "실시간 라이브 채널 (기본)"
                    this.episode_number = 1f
                    this.url = "/play?stream_data=" + java.net.URLEncoder.encode(fallbackUrl, "UTF-8")
                }
            )
        }

        // 최신순 정렬을 위해 리스트 반전
        return episodeList.reversed()
    }

    // ================= 4. 비디오 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val encodedData = response.request.url.queryParameter("stream_data") ?: ""
        val decodedData = java.net.URLDecoder.decode(encodedData, "UTF-8")

        // URL 규격 조립
        val playUrl = if (decodedData.startsWith("http")) {
            decodedData // 이미 풀 URL인 경우
        } else if (decodedData.contains("/")) {
            // "131/56ad7640b9ad" 같은 토큰 형태인 경우
            "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$decodedData/index.m3u8?site=njtv-01.com"
        } else {
            // 단일 키 형태인 경우
            "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$decodedData/playlist.m3u8?site=njtv-01.com"
        }

        // 비디오 재생용 CDN 위장 헤더
        val mediaHeaders = Headers.Builder()
            .set("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
            .set("Referer", "$baseUrl/")
            .set("Origin", baseUrl)
            .set("Accept", "*/*")
            .build()

        return listOf(
            Video(playUrl, "실시간 라이브 (HLS)", playUrl, mediaHeaders)
        )
    }

    override fun videoUrlParse(response: Response): String = ""
}
