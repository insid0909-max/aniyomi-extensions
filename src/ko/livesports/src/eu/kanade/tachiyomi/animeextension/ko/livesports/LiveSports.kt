package eu.kanade.tachiyomi.animeextension.ko.livesports

import android.annotation.SuppressLint
import android.app.Application
import android.os.Handler
import android.os.Looper
import android.util.Base64
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
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

class LiveSports : AnimeHttpSource() {

    override val name = "실시간스포츠"
    override val baseUrl = "https://njtv-01.com"
    override val lang = "ko"
    override val supportsLatest = false

    private val livePageUrl = "$baseUrl/bbs/page.php?hid=livetv_a"
    private val iframeUrl = "https://xvqz.org/content/V28Ew6LP/modern/dark"

    // TODO: 실제 iframe-streams.json 주소로 교체 (개발자도구 Network 탭에서 확인)
    private val streamsJsonUrl = "https://xvqz.org/iframe-streams.json"

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
                setUrlWithoutDomain("/sport?cat=" + URLEncoder.encode(catName, "UTF-8"))
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

    // ================= 2. AES 복호화 (키 후보 순회) =================
    private val candidateKeys = listOf(
        "44g244g044k044c2", "44gR44cz44kM44o9", "44gR55YB44oD44gk", "44kK44c844g55lUS",
        "44kp44cH44gE44c9", "55EY5A2556IC5OUB", "57Iz5zkW5QcI5PEj", "5PgO55IJ6AcQ6ycV",
        "5PkA55UA6AoA6ycd", "5QYc5z6E55Ip5Pg5", "5yYD5BcD55UK5Po9", "666M7iMH7lE56RwJ",
        "6RgM7kAv7iok7zwJ", "7jsQ7iMz64U464Mi", "7kEw6Rg47lkP6RUJ", "7ycO7zAX7is57jUC",
        "E8oUWPhdSHantmou", "FM3dO8kyWORcUmo0", "W49NACkVWP8FW6Ww", "W4HBm8kOW7TKW5Ha",
        "W4SFvmoMW6fbWRuy", "W4XHoCkjWQRdNKaP", "W4vhWQBcUSoGDmoJW47dSSojWRCNWRzl",
        "W57dMaJcNuZdGSopW7ZdO8oRWR5JWQ8B", "W5DgW7nDrtRdTs92", "W5KMWQpdJhSmyCoQ",
        "W5ddLcBcPcC6kKDB", "W6O7jSoiiJ9RWPTd", "W6SrF8kzt8k2dmoV", "W6mWysHBEZpdQ8oi",
        "W70j44cd44k444ku", "W7DR44gU44c244oH", "W7b8WRhdQmklWOJcO8oAE8k8W5rwE8kD",
        "W7bKxJddK1FdNSoL", "W7izW5tcO8kVW6yc", "W7pdH1eSW7ddHCkF", "W7qkW6ddJSkPd8kC",
        "WOBdLf4UAsFcQCkC", "WOlcJSoNW4eiW7uQ", "WOmXW5jys8kxW7vG", "WPFSPi3SNBDX7lkZ",
        "WPJdN1dcICkNe8o6", "WPWFqZpdOSoXfmkE", "WQ3dLaypegNcJCkL", "WRTHWPJcJWG9Buua",
        "arpcHmoJb8kSWOvR", "dG4XWPqcW6pcJfa0", "dIRdLSkdoMRdJ8ku", "dhhcQJNdKmkKlaCo",
        "f8ocxSobkepdL8oH", "nu7dHSkrW43cJSoF", "rCkdaCkNzmocsSkC", "wfSzWRnYdJ7dHCoq",
        "yLdcPSo7hSkKpwGk", "zmoUWPRcT0KLemk3",
    )

    // 한 번 찾은 키는 메모리에 캐시 (키를 확정하면 candidateKeys를 지우고 여기에 하드코딩)
    @Volatile
    private var cachedKey: String? = null

    private fun decryptWith(key: String, iv: ByteArray, data: ByteArray): String? = try {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key.toByteArray(Charsets.UTF_8), "AES"),
            IvParameterSpec(iv),
        )
        val text = String(cipher.doFinal(data), Charsets.UTF_8).trim()
        // 우연히 패딩이 맞는 오답 키를 거르기 위해 실제 JSON 파싱까지 검증
        when {
            text.startsWith("[") -> JSONArray(text)
            text.startsWith("{") -> JSONObject(text)
            else -> null
        }?.let { text }
    } catch (e: Exception) {
        null
    }

    private fun findValidKeyAndDecrypt(payload: String): String? {
        return try {
            var raw = payload.trim()
            // 전체가 Base64로 한 번 더 감싸진 경우 대비
            if (!raw.startsWith("{")) {
                raw = String(Base64.decode(raw, Base64.DEFAULT), Charsets.UTF_8).trim()
            }
            val json = JSONObject(raw)
            val iv = Base64.decode(json.getString("iv"), Base64.DEFAULT)
            val value = Base64.decode(json.getString("value"), Base64.DEFAULT)

            cachedKey?.let { k -> decryptWith(k, iv, value)?.let { return it } }

            for (key in candidateKeys) {
                val result = decryptWith(key, iv, value) ?: continue
                cachedKey = key
                Log.d("LiveSports", "Found key: $key")
                return result
            }
            null
        } catch (e: Exception) {
            Log.d("LiveSports", "payload parse failed: ${e.message}")
            null
        }
    }

    private fun fetchDecryptedStreams(): String? = try {
        val body = client.newCall(GET(streamsJsonUrl, headers)).execute().use { it.body?.string() }
        if (body.isNullOrBlank()) null else findValidKeyAndDecrypt(body)
    } catch (e: Exception) {
        Log.d("LiveSports", "fetch failed: ${e.message}")
        null
    }

    // ================= 3. 웹뷰 후킹 (복호화 실패 시 폴백) =================
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun getDecryptedDataViaWebView(targetUrl: String): String {
        @Volatile var result = ""
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
                webView.settings.userAgentString = headersBuilder().build()["User-Agent"]

                webView.addJavascriptInterface(
                    object {
                        @JavascriptInterface
                        fun onData(data: String) {
                            if (result.isEmpty()) {
                                result = data
                                latch.countDown()
                            }
                        }
                    },
                    "Android",
                )

                webView.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val url = request.url.toString()

                        if (url.endsWith(".js") && url.contains("xvqz.org")) {
                            try {
                                val req = Request.Builder().url(url).header("Referer", targetUrl).build()
                                val originalJs = client.newCall(req).execute().use { it.body?.string() ?: "" }

                                val hookedJs = """
                                    var _origParse = JSON.parse;
                                    JSON.parse = function(t) {
                                        try {
                                            if (typeof t === 'string' && (t.includes('stream') || t.includes('name'))) {
                                                if (window.Android) window.Android.onData(t);
                                            }
                                        } catch(e) {}
                                        return _origParse(t);
                                    };
                                    $originalJs
                                """.trimIndent()

                                return WebResourceResponse(
                                    "application/javascript",
                                    "UTF-8",
                                    ByteArrayInputStream(hookedJs.toByteArray(Charsets.UTF_8)),
                                )
                            } catch (e: Exception) {
                                e.printStackTrace()
                            }
                        }

                        if (url.contains(".m3u8") && result.isEmpty()) {
                            result = url
                            latch.countDown()
                        }

                        return super.shouldInterceptRequest(view, request)
                    }
                }

                webView.loadUrl(targetUrl, mutableMapOf("Referer" to livePageUrl))
            } catch (e: Exception) {
                latch.countDown()
            }
        }

        latch.await(12, TimeUnit.SECONDS)
        // 메모리 누수 방지: 사용한 WebView 정리
        handler.post {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }
        return result
    }

    // ================= 4. 실시간 경기 목록 =================
    private fun parseEpisodes(jsonText: String): List<SEpisode> {
        val array = when {
            jsonText.startsWith("[") -> JSONArray(jsonText)
            else -> JSONObject(jsonText).let {
                it.optJSONArray("streams") ?: it.optJSONArray("data") ?: JSONArray()
            }
        }
        val list = mutableListOf<SEpisode>()
        var count = 1f
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val name = item.optString("name", item.optString("title", "실시간 경기 $count"))
            val url = item.optString("url", item.optString("stream", item.optString("key", "")))
            if (url.isNotEmpty()) {
                list.add(
                    SEpisode.create().apply {
                        this.name = name
                        episode_number = count++
                        this.url = "/play?stream_data=" + URLEncoder.encode(url, "UTF-8")
                    },
                )
            }
        }
        return list
    }

    private fun m3u8Episode(url: String) = SEpisode.create().apply {
        name = "실시간 라이브 채널 (자동감지)"
        episode_number = 1f
        this.url = "/play?stream_data=" + URLEncoder.encode(url, "UTF-8")
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        // 1순위: iframe-streams.json 직접 요청 + AES 복호화
        val decrypted = fetchDecryptedStreams()
        if (decrypted != null) {
            try {
                val episodes = parseEpisodes(decrypted)
                if (episodes.isNotEmpty()) return episodes.reversed()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }

        // 2순위: 웹뷰 후킹
        val hooked = getDecryptedDataViaWebView(iframeUrl).trim()
        return try {
            when {
                hooked.startsWith("[") -> parseEpisodes(hooked).reversed()
                hooked.contains(".m3u8") -> listOf(m3u8Episode(hooked))
                else -> emptyList()
            }
        } catch (e: Exception) {
            e.printStackTrace()
            emptyList()
        }
    }

    // ================= 5. 비디오 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val encodedData = response.request.url.queryParameter("stream_data") ?: ""
        val decodedData = URLDecoder.decode(encodedData, "UTF-8")

        val playUrl = when {
            decodedData.startsWith("http") -> decodedData
            decodedData.contains("/") ->
                "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$decodedData/index.m3u8?site=njtv-01.com"
            else ->
                "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$decodedData/playlist.m3u8?site=njtv-01.com"
        }

        val mediaHeaders = Headers.Builder()
            .set("User-Agent", headersBuilder().build()["User-Agent"]!!)
            .set("Referer", "$baseUrl/")
            .set("Origin", baseUrl)
            .set("Accept", "*/*")
            .build()

        return listOf(Video(playUrl, "실시간 라이브 (HLS)", playUrl, mediaHeaders))
    }

    override fun videoUrlParse(response: Response): String = ""
}
