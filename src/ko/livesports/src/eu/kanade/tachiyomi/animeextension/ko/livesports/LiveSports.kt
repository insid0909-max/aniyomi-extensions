package eu.kanade.tachiyomi.animeextension.ko.livesports

import android.annotation.SuppressLint
import android.app.Application
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
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
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URLEncoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LiveSports : AnimeHttpSource() {

    override val name = "실시간스포츠"
    override val baseUrl = "https://njtv-01.com"
    override val lang = "ko"
    override val supportsLatest = false

    private val tag = "LiveSports"
    private val livePageUrl = "$baseUrl/bbs/page.php?hid=livetv_a"

    // 페이지 로드 중 가로챈 값들 (호스트는 수시로 바뀌므로 매번 새로 읽음)
    @Volatile private var capturedJson: String? = null
    @Volatile private var capturedM3u8: String? = null
    @Volatile private var iframeHost: String? = null
    @Volatile private var liveHost: String? = null
    @Volatile private var candidateHeads = ""
    @Volatile private var firstItemDebug = ""

    override val client: OkHttpClient = network.cloudflareClient

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")
        .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
        .set(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        )

    // ================= 1. 종목 카테고리 =================
    override fun popularAnimeRequest(page: Int): Request = GET(livePageUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val categories = listOf("전체 경기", "축구", "야구", "농구", "배구", "기타")
        val animeList = categories.map { catName ->
            SAnime.create().apply {
                title = catName
                setUrlWithoutDomain("/live2?cat=" + URLEncoder.encode(catName, "UTF-8"))
            }
        }
        return AnimesPage(animeList, false)
    }

    override fun latestUpdatesRequest(page: Int): Request = popularAnimeRequest(page)
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = popularAnimeRequest(1)
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    override fun animeDetailsRequest(anime: SAnime): Request = GET(livePageUrl, headers)

    override fun animeDetailsParse(response: Response): SAnime = SAnime.create().apply {
        title = "실시간 스포츠 중계"
        status = SAnime.ONGOING
    }

    override fun episodeListRequest(anime: SAnime): Request = GET(livePageUrl, headers)

    override fun videoListRequest(episode: SEpisode): Request {
        val data = episode.url.substringAfter("stream_data=", "")
        return GET("$livePageUrl&stream_data=$data", headers)
    }

    // ================= 2. JSON 해석 =================
    private val nameKeys = listOf("name", "title", "label", "channel", "text")
    private val urlKeys = listOf("url", "stream", "key", "id", "src", "file", "hls", "slug", "path")

    // 최상위 배열이거나, 객체 안의 첫 번째 "객체 배열"을 찾음 (암호문 래퍼 {"iv","value"}는 null)
    private fun findArray(text: String): JSONArray? {
        val t = text.trim()
        if (t.startsWith("[")) return JSONArray(t)
        if (!t.startsWith("{")) return null
        val obj = JSONObject(t)
        val keys = obj.keys()
        while (keys.hasNext()) {
            val v = obj.opt(keys.next())
            if (v is JSONArray && v.length() > 0 && v.optJSONObject(0) != null) return v
        }
        return null
    }

    private fun looksLikeStreams(arr: JSONArray): Boolean {
        val first = arr.optJSONObject(0) ?: return false
        return urlKeys.any { first.has(it) }
    }

    private fun firstString(item: JSONObject, keys: List<String>): String {
        for (k in keys) {
            val v = item.opt(k)
            if (v is String && v.isNotEmpty()) return v
            if (v is Number) return v.toString()
        }
        return ""
    }

    private fun parseEpisodes(jsonText: String): List<SEpisode> {
        val array = findArray(jsonText) ?: return emptyList()
        Log.d(tag, "first item: ${array.opt(0)}")
        firstItemDebug = array.opt(0).toString().take(300)

        val list = mutableListOf<SEpisode>()
        var count = 1f
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val streamData = firstString(item, urlKeys)
            if (streamData.isEmpty()) continue
            val title = firstString(item, nameKeys).ifEmpty { "실시간 경기 ${count.toInt()}" }
            list.add(
                SEpisode.create().apply {
                    this.name = title
                    episode_number = count++
                    this.url = "/play?stream_data=" + URLEncoder.encode(streamData, "UTF-8")
                },
            )
        }
        return list
    }

    // ================= 3. 부모 페이지를 WebView로 열어 가로채기 =================
    // 플레이어 JS가 복호화한 뒤 JSON.parse에 넘기는 문자열을 낚아챈다
    private val hookPrefix = """
        (function(){
          if (window.__lsHook) return;
          window.__lsHook = true;
          var o = JSON.parse;
          JSON.parse = function(t) {
            try {
              if (typeof t === 'string' && t.length > 20 && (t.charAt(0) === '[' || t.charAt(0) === '{')) {
                var b = window.Android;
                if (!b) { try { b = window.top.Android; } catch (e) {} }
                if (b) b.onData(t);
              }
            } catch (e) {}
            return o.apply(this, arguments);
          };
        })();
    """.trimIndent()

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun captureFromPage() {
        capturedJson = null
        capturedM3u8 = null
        candidateHeads = ""

        val latch = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        var webViewRef: WebView? = null

        handler.post {
            try {
                val context = Class.forName("android.app.ActivityThread")
                    .getMethod("currentApplication")
                    .invoke(null) as Application

                val webView = WebView(context)
                webViewRef = webView
                webView.settings.javaScriptEnabled = true
                webView.settings.domStorageEnabled = true
                webView.settings.mediaPlaybackRequiresUserGesture = false
                webView.settings.userAgentString = headersBuilder().build()["User-Agent"]

                webView.addJavascriptInterface(
                    object {
                        @JavascriptInterface
                        fun onData(data: String) {
                            if (candidateHeads.length < 300) {
                                candidateHeads += " [" + data.take(50).replace("\n", " ") + "]"
                            }
                            if (capturedJson == null) {
                                val arr = try { findArray(data) } catch (e: Exception) { null }
                                if (arr != null && arr.length() > 0 && looksLikeStreams(arr)) {
                                    capturedJson = data
                                    latch.countDown()
                                }
                            }
                        }
                    },
                    "Android",
                )

                webView.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? {
                        val uri = request.url
                        val url = uri.toString()
                        val host = uri.host ?: ""
                        val path = uri.path ?: ""

                        if (host.endsWith(".xvqz.org") && path.startsWith("/build/")) {
                            iframeHost = host
                        }

                        // 플레이어 JS 맨 앞에 JSON.parse 후킹 코드를 붙여서 제공
                        if (host.endsWith(".xvqz.org") && path.endsWith(".js")) {
                            try {
                                val rb = Request.Builder().url(url)
                                request.requestHeaders.forEach { (k, v) ->
                                    if (!k.equals("Accept-Encoding", true)) rb.header(k, v)
                                }
                                val body = client.newCall(rb.build()).execute().use { res ->
                                    if (res.isSuccessful) res.body?.string() else null
                                }
                                if (body != null) {
                                    val hooked = hookPrefix + "\n" + body
                                    return WebResourceResponse(
                                        "application/javascript",
                                        "UTF-8",
                                        200,
                                        "OK",
                                        mapOf("Access-Control-Allow-Origin" to "*"),
                                        ByteArrayInputStream(hooked.toByteArray(Charsets.UTF_8)),
                                    )
                                }
                            } catch (e: Exception) {
                                Log.d(tag, "js hook failed: ${e.message}")
                            }
                        }

                        if (url.contains(".m3u8") && capturedM3u8 == null) {
                            capturedM3u8 = url
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }

                webView.loadUrl(livePageUrl, mutableMapOf("Referer" to "$baseUrl/"))
            } catch (e: Exception) {
                Log.d(tag, "webview error: ${e.message}")
                latch.countDown()
            }
        }

        latch.await(15, TimeUnit.SECONDS)
        // JSON 직후에 m3u8이 따라오므로 조금 더 기다림
        var waited = 0
        while (capturedM3u8 == null && waited < 6000) {
            Thread.sleep(250)
            waited += 250
        }

        handler.post {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }

        capturedM3u8?.let { liveHost = Uri.parse(it).host }
        Log.d(tag, "iframeHost=$iframeHost liveHost=$liveHost json=${capturedJson?.length}")
    }

    // ================= 4. 실시간 경기 목록 =================
    private fun m3u8Episode(url: String) = SEpisode.create().apply {
        name = "실시간 라이브 채널 (자동감지)"
        episode_number = 1f
        this.url = "/play?stream_data=" + URLEncoder.encode(url, "UTF-8")
    }

    private fun debugEpisode(msg: String) = SEpisode.create().apply {
        name = "DEBUG: $msg"
        episode_number = 2f
        this.url = "/play?stream_data=debug"
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        captureFromPage()

        val json = capturedJson
        val episodes = if (json != null) {
            try { parseEpisodes(json) } catch (e: Exception) { emptyList() }
        } else {
            emptyList()
        }
        if (episodes.isNotEmpty()) return episodes.reversed()

        // 실패 시: 자동감지 채널 + 원인 확인용 DEBUG 줄
        val result = mutableListOf<SEpisode>()
        capturedM3u8?.let { result.add(m3u8Episode(it)) }
        result.add(
            debugEpisode(
                "json=${json?.take(60)} cand=$candidateHeads m3u8=${capturedM3u8 != null} iframe=$iframeHost",
            ),
        )
        return result
    }

    // ================= 5. 비디오 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val data = response.request.url.queryParameter("stream_data") ?: ""
        if (data.isEmpty() || data == "debug") {
            throw Exception("stream_data 비어있음 item=$firstItemDebug")
        }

        // 호스트 후보: 가로챈 호스트 + 확인된 호스트 2개 (순서대로 시도)
        val hosts: List<String?> = if (data.startsWith("http")) {
            listOf(null)
        } else {
            listOfNotNull(
                liveHost,
                "ol3ktizakokhjhnu.kjhsdfuie.work",
                "daxnb7e8nd4e0hdj.kjhsdfuie.work",
            ).distinct()
        }
        // Referer 후보: iframe 호스트 → xvqz.org → 메인 사이트
        val referers = listOfNotNull(
            iframeHost?.let { "https://$it/" },
            "https://xvqz.org/",
            "$baseUrl/",
        ).distinct()

        val ua = headersBuilder().build()["User-Agent"]!!
        var lastError = ""

        for (host in hosts) {
            val playUrl = if (host == null) {
                data
            } else {
                "https://$host/live/$data/playlist.m3u8?site=njtv-01.com"
            }

            for (ref in referers) {
                val mediaHeaders = Headers.Builder()
                    .set("User-Agent", ua)
                    .set("Referer", ref)
                    .set("Origin", ref.trimEnd('/'))
                    .set("Accept", "*/*")
                    .build()
                try {
                    val res = client.newCall(GET(playUrl, mediaHeaders)).execute()
                    val code = res.code
                    val head = res.use { it.body?.string()?.take(12) ?: "" }
                    if (code == 200 && head.startsWith("#EXTM3U")) {
                        return listOf(Video(playUrl, "실시간 라이브 (HLS)", playUrl, mediaHeaders))
                    }
                    lastError = "code=$code head=$head host=$host ref=$ref"
                } catch (e: Exception) {
                    lastError = "예외 ${e.message} host=$host"
                }
            }
        }

        // 실패하면 원인을 토스트로 보여줌
        throw Exception("재생 실패 data=$data | $lastError | item=$firstItemDebug")
    }

    
    override fun videoUrlParse(response: Response): String = ""
}

