package eu.kanade.tachiyomi.animeextension.ko.livesports

import android.annotation.SuppressLint
import android.app.Application
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
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
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LiveSports : AnimeHttpSource() {

    override val name = "실시간스포츠"
    override val baseUrl = "https://njtv-01.com"
    override val lang = "ko"
    override val supportsLatest = false

    private val livePageUrl = "$baseUrl/bbs/page.php?hid=livetv_a"
    private val iframeUrl = "https://xvqz.org/content/V28Ew6LP/modern/dark"

    override val client: OkHttpClient = network.cloudflareClient

    override fun headersBuilder(): Headers.Builder = network.cloudflareClient.newBuilder().build().let {
        super.headersBuilder()
            .set("Referer", "$baseUrl/")
            .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
            .set("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
    }

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
    override fun animeDetailsParse(response: Response): SAnime = SAnime.create().apply {
        title = "실시간 스포츠 중계"
        status = SAnime.ONGOING
    }

    // ================= 2. 웹뷰 기반 자바스크립트 후킹 (핵심) =================
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun getDecryptedDataViaWebView(targetUrl: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())

        handler.post {
            try {
                val context = Injekt.get<Application>()
                val webView = WebView(context)
                webView.settings.javaScriptEnabled = true
                webView.settings.domStorageEnabled = true
                webView.settings.userAgentString = headersBuilder().build()["User-Agent"]

                // 코틀린과 자바스크립트를 연결하는 브릿지 생성
                webView.addJavascriptInterface(object {
                    @JavascriptInterface
                    fun onData(data: String) {
                        if (result.isEmpty()) {
                            result = data
                            latch.countDown()
                        }
                    }
                }, "Android")

                webView.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val url = request.url.toString()
                        
                        // 사이트의 JS 파일이 로드될 때 가로채서 JSON.parse 함수를 변조(Hooking)함
                        if (url.endsWith(".js") && url.contains("xvqz.org")) {
                            try {
                                val req = Request.Builder().url(url).header("Referer", targetUrl).build()
                                val res = client.newCall(req).execute()
                                val originalJs = res.body?.string() ?: ""
                                
                                val hookedJs = """
                                    var _origParse = JSON.parse;
                                    JSON.parse = function(t) {
                                        try {
                                            // 복호화된 문자열이 JSON 객체로 변환되기 직전에 낚아챔
                                            if (typeof t === 'string' && (t.includes('stream') || t.includes('name'))) {
                                                if (window.Android) window.Android.onData(t);
                                            }
                                        } catch(e) {}
                                        return _origParse(t);
                                    };
                                    $originalJs
                                """.trimIndent()
                                
                                val stream = ByteArrayInputStream(hookedJs.toByteArray(Charsets.UTF_8))
                                return WebResourceResponse("application/javascript", "UTF-8", stream)
                            } catch (e: Exception) {
                                e.printStackTrace()
                            }
                        }
                        
                        // 혹시 JSON 후킹보다 m3u8 요청이 먼저 지나가면 그것이라도 낚아챔 (백업 플랜)
                        if (url.contains(".m3u8")) {
                            if (result.isEmpty()) {
                                result = url
                                latch.countDown()
                            }
                        }
                        
                        return super.shouldInterceptRequest(view, request)
                    }
                }

                // 권한 거부를 막기 위해 메인 페이지 위장 헤더를 달고 실행
                val headersMap = mutableMapOf<String, String>()
                headersMap["Referer"] = livePageUrl
                webView.loadUrl(targetUrl, headersMap)

            } catch (e: Exception) {
                latch.countDown()
            }
        }

        // 백그라운드 스레드에서 최대 12초 대기 (데이터를 찾는 즉시 통과)
        latch.await(12, TimeUnit.SECONDS)
        return result
    }

    // ================= 3. 실시간 경기 목록 =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episodeList = mutableListOf<SEpisode>()

        // 1. 웹뷰를 돌려 복호화된 JSON 데이터를 획득
        val decryptedData = getDecryptedDataViaWebView(iframeUrl)

        if (decryptedData.trim().startsWith("[")) {
            try {
                val jsonArray = JSONArray(decryptedData)
                var count = 1f
                for (i in 0 until jsonArray.length()) {
                    val item = jsonArray.optJSONObject(i) ?: continue
                    val name = item.optString("name", item.optString("title", "실시간 경기 $count"))
                    val url = item.optString("url", item.optString("stream", item.optString("key", "")))

                    if (url.isNotEmpty()) {
                        episodeList.add(
                            SEpisode.create().apply {
                                this.name = name
                                this.episode_number = count++
                                this.url = "/play?stream_data=" + java.net.URLEncoder.encode(url, "UTF-8")
                            }
                        )
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        } else if (decryptedData.contains(".m3u8")) {
            // 2. JSON은 놓쳤으나 실시간 m3u8 자체를 낚아챈 경우
            episodeList.add(
                SEpisode.create().apply {
                    this.name = "실시간 라이브 채널 (자동감지)"
                    this.episode_number = 1f
                    this.url = "/play?stream_data=" + java.net.URLEncoder.encode(decryptedData, "UTF-8")
                }
            )
        }

        // 최신순 출력을 위해 역순 정렬
        return episodeList.reversed()
    }

    // ================= 4. 비디오 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val encodedData = response.request.url.queryParameter("stream_data") ?: ""
        val decodedData = java.net.URLDecoder.decode(encodedData, "UTF-8")

        // URL 조립 (단일 키, 복합 토큰, 풀 URL 모두 완벽 대응)
        val playUrl = if (decodedData.startsWith("http")) {
            decodedData
        } else if (decodedData.contains("/")) {
            "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$decodedData/index.m3u8?site=njtv-01.com"
        } else {
            "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$decodedData/playlist.m3u8?site=njtv-01.com"
        }

        val mediaHeaders = Headers.Builder()
            .set("User-Agent", headersBuilder().build()["User-Agent"]!!)
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
