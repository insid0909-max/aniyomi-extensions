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

    private val tag = "LiveSports"
    private val livePageUrl = "$baseUrl/bbs/page.php?hid=livetv_a"
    private val iframeUrl = "https://xvqz.org/content/V28Ew6LP/modern/dark"

    // 재생 요청 Referer/Origin. 400이 계속 나면 baseUrl 쪽으로도 테스트
    private val playReferer = "https://xvqz.org/"
    private val playOrigin = "https://xvqz.org"

    // 실패 단계를 화면(에피소드 이름)에 보여주기 위한 디버그 문자열
    @Volatile
    private var lastDebug = "init"

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
                // URL을 바꿔서 앱 DB에 남은 옛 항목과 분리 (/live2)
                setUrlWithoutDomain("/live2?cat=" + URLEncoder.encode(catName, "UTF-8"))
            }
        }
        return AnimesPage(animeList, false)
    }

    override fun latestUpdatesRequest(page: Int): Request = popularAnimeRequest(page)
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = popularAnimeRequest(1)
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    // 가짜 경로로 요청하지 않도록 실제 페이지로 고정
    override fun animeDetailsRequest(anime: SAnime): Request = GET(livePageUrl, headers)

    override fun animeDetailsParse(response: Response): SAnime = SAnime.create().apply {
        title = "실시간 스포츠 중계"
        status = SAnime.ONGOING
    }

    override fun episodeListRequest(anime: SAnime): Request = GET(livePageUrl, headers)

    // 재생 요청도 실제 페이지로 보내되 stream_data만 쿼리로 전달
    override fun videoListRequest(episode: SEpisode): Request {
        val data = episode.url.substringAfter("stream_data=", "")
        return GET("$livePageUrl&stream_data=$data", headers)
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

    // 정답 키를 찾으면 캐시. 확정되면 candidateKeys를 지우고 이 값만 하드코딩
    @Volatile
    private var cachedKey: String? = null

    // 원문 UTF-8 바이트, Base64 디코드 바이트 중 AES 키 길이(16/24/32)에 맞는 것만 후보
    private fun keyVariants(key: String): List<ByteArray> {
        val validSizes = listOf(16, 24, 32)
        val list = mutableListOf<ByteArray>()
        val raw = key.toByteArray(Charsets.UTF_8)
        if (raw.size in validSizes) list.add(raw)
        try {
            val dec = Base64.decode(key, Base64.DEFAULT)
            if (dec.size in validSizes) list.add(dec)
        } catch (e: Exception) {
            // Base64가 아니면 무시
        }
        return list
    }

    private fun decryptWith(key: String, iv: ByteArray, data: ByteArray): String? {
        for (keyBytes in keyVariants(key)) {
            try {
                val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    SecretKeySpec(keyBytes, "AES"),
                    IvParameterSpec(iv),
                )
                val text = String(cipher.doFinal(data), Charsets.UTF_8).trim()
                // 우연히 패딩이 맞는 오답 키를 거르기 위해 실제 JSON 파싱까지 검증
                val ok = when {
                    text.startsWith("[") -> JSONArray(text)
                    text.startsWith("{") -> JSONObject(text)
                    else -> null
                }
                if (ok != null) return text
            } catch (e: Exception) {
                // 키가 틀리면 예외 발생. 다음 후보로
            }
        }
        return null
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
                Log.d(tag, "Found key: $key")
                return result
            }
            Log.d(tag, "no key matched")
            lastDebug += " / 키 불일치(55개 모두 실패)"
            null
        } catch (e: Exception) {
            Log.d(tag, "payload parse failed: ${e.message}")
            lastDebug += " / 페이로드 형식 오류: ${e.message}"
            null
        }
    }

    private fun fetchDecryptedStreams(): String? {
        return try {
            val domainRegex = """https?://([a-zA-Z0-9-]+\.xvqz\.org)""".toRegex()

            // 1순위: iframe 페이지를 열어 리다이렉트된 실제 서브도메인 사용
            val iframeRes = client.newCall(GET(iframeUrl, headers)).execute()
            val iframeHtml = iframeRes.use { it.body?.string() ?: "" }
            var host: String? = iframeRes.request.url.host
                .takeIf { it.endsWith(".xvqz.org") }

            // 2순위: iframe HTML에서 탐색
            if (host == null) host = domainRegex.find(iframeHtml)?.groupValues?.get(1)

            // 3순위: 메인 페이지 HTML에서 탐색
            if (host == null) {
                val mainHtml = client.newCall(GET(livePageUrl, headers)).execute()
                    .use { it.body?.string() ?: "" }
                host = domainRegex.find(mainHtml)?.groupValues?.get(1)
            }

            if (host == null) {
                Log.d(tag, "dynamic host not found")
                lastDebug = "host 못 찾음(iframe 길이=${iframeHtml.length})"
                return null
            }

            val jsonUrl = "https://$host/data/iframe-streams.json"
            Log.d(tag, "Target JSON URL: $jsonUrl")
            lastDebug = "url=$jsonUrl"

            val jsonHeaders = headersBuilder()
                .set("Referer", iframeUrl)
                .set("Origin", "https://$host")
                .build()
            val res = client.newCall(GET(jsonUrl, jsonHeaders)).execute()
            val code = res.code
            val body = res.use { it.body?.string() }
            Log.d(tag, "json code=$code length=${body?.length}, head=${body?.take(60)}")
            lastDebug = "code=$code len=${body?.length} head=${body?.take(40)} url=$jsonUrl"

            if (body.isNullOrBlank()) null else findValidKeyAndDecrypt(body)
        } catch (e: Exception) {
            Log.d(tag, "fetch failed: ${e.message}")
            lastDebug = "예외: ${e.message}"
            null
        }
    }

    // ================= 3. 웹뷰 후킹 (복호화 실패 시 폴백) =================
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun getDecryptedDataViaWebView(targetUrl: String): String {
        var result = ""
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
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? {
                        val url = request.url.toString()

                        // 쿼리가 붙은 js(app.js?v=1)도 잡도록 쿼리 제거 후 확인
                        if (url.substringBefore("?").endsWith(".js") && url.contains("xvqz.org")) {
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
                lastDebug += " / 웹뷰 예외: ${e.message}"
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
        if (array.length() > 0) {
            Log.d(tag, "first item: ${array.opt(0)}")
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

    private fun debugEpisode(msg: String) = SEpisode.create().apply {
        name = "DEBUG: $msg"
        episode_number = 1f
        this.url = "/play?stream_data=debug"
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        lastDebug = "시작"

        // 1순위: iframe-streams.json 직접 요청 + AES 복호화
        val decrypted = fetchDecryptedStreams()
        if (decrypted != null) {
            try {
                val episodes = parseEpisodes(decrypted)
                if (episodes.isNotEmpty()) return episodes.reversed()
                lastDebug = "복호화 OK, 항목 0개 head=${decrypted.take(120)}"
            } catch (e: Exception) {
                lastDebug = "복호화 OK, 파싱 예외 ${e.message} head=${decrypted.take(80)}"
            }
        }

        // 2순위: 웹뷰 후킹
        Log.d(tag, "fallback to WebView hook: $lastDebug")
        val debugBeforeHook = lastDebug
        val hooked = getDecryptedDataViaWebView(iframeUrl).trim()
        return try {
            when {
                hooked.startsWith("[") || hooked.startsWith("{") -> parseEpisodes(hooked).reversed()
                hooked.contains(".m3u8") -> listOf(m3u8Episode(hooked))
                else -> listOf(debugEpisode("후킹도 실패 | $debugBeforeHook"))
            }
        } catch (e: Exception) {
            listOf(debugEpisode("후킹 파싱예외 ${e.message} | $debugBeforeHook"))
        }
    }

    // ================= 5. 비디오 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        // queryParameter가 이미 디코딩해 주므로 추가 디코딩하지 않음
        val data = response.request.url.queryParameter("stream_data") ?: ""

        val playUrl = when {
            data.startsWith("http") -> data
            data.contains("/") ->
                "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$data/index.m3u8?site=njtv-01.com"
            else ->
                "https://ct7p46hmd4x9bic2.kjhsdfuie.work/live/$data/playlist.m3u8?site=njtv-01.com"
        }
        Log.d(tag, "decoded=$data play=$playUrl")

        val mediaHeaders = Headers.Builder()
            .set("User-Agent", headersBuilder().build()["User-Agent"]!!)
            .set("Referer", playReferer)
            .set("Origin", playOrigin)
            .set("Accept", "*/*")
            .build()

        return listOf(Video(playUrl, "실시간 라이브 (HLS)", playUrl, mediaHeaders))
    }

    override fun videoUrlParse(response: Response): String = ""
}
