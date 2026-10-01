package eu.kanade.tachiyomi.animeextension.ko.livesports

import android.annotation.SuppressLint
import android.app.Application
import android.content.SharedPreferences
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LiveSports : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "실시간스포츠"
    override val lang = "ko"
    override val supportsLatest = false

    private val tag = "LiveSports"

    // ================= 0. 사이트 주소 (직접 지정 설정) =================
    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    // 설정에 올바른 주소가 있으면 그것을, 아니면 기본 주소를 사용
    override val baseUrl: String
        get() {
            val custom = prefs()?.getString(PREF_DOMAIN_KEY, "")
                ?.trim()?.trimEnd('/').orEmpty()
            return if (custom.isNotEmpty() && DOMAIN_REGEX.matches(custom)) custom else DEFAULT_BASE_URL
        }

    private val livePageUrl: String
        get() = "$baseUrl/bbs/page.php?hid=livetv_a"

    // 영상 주소의 ?site= 값 (현재 사이트 도메인에 맞춤)
    private val siteHost: String
        get() = try {
            baseUrl.toHttpUrl().host
        } catch (e: Exception) {
            "njtv-01.com"
        }

    // 페이지 로드 중 가로챈 값들 (호스트는 수시로 바뀌므로 매번 새로 읽음)
    @Volatile private var capturedJson: String? = null
    @Volatile private var capturedM3u8: String? = null
    @Volatile private var iframeHost: String? = null
    @Volatile private var liveHost: String? = null
    @Volatile private var candidateHeads = ""
    @Volatile private var firstItemDebug = ""
    @Volatile private var lastCaptureTime = 0L

    // 목록 추출에 필요 없는 리소스 (이미지/폰트)는 차단해서 로딩을 줄임
    private val blockedAssets = Regex(""".*\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$""", RegexOption.IGNORE_CASE)

    override val client: OkHttpClient = network.cloudflareClient

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")
        .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
        .set(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        )

    // ================= 1. 카드 (하나만 표시) =================
    override fun popularAnimeRequest(page: Int): Request = GET(livePageUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val anime = SAnime.create().apply {
            title = "실시간 스포츠 중계"
            // 기존 "전체 경기" 카드와 같은 주소를 써서 앱에 저장된 항목과 이어지게 함
            setUrlWithoutDomain("/live2?cat=" + URLEncoder.encode("전체 경기", "UTF-8"))
        }
        return AnimesPage(listOf(anime), false)
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
    private val nameKeys = listOf("name", "title", "label", "channel", "text", "match", "game")
    private val urlKeys = listOf("stream", "streamKey", "key", "url", "src", "file", "hls", "slug", "path", "id")
    private val skipKeys = listOf("date", "time", "image", "img", "logo", "thumb", "poster", "icon", "league", "status")

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
        return first.length() >= 2
    }

    private fun firstString(item: JSONObject, keys: List<String>): String {
        for (k in keys) {
            val v = item.opt(k)
            if (v is String && v.isNotEmpty()) return v
            if (v is Number) return v.toString()
        }
        return ""
    }

    // 중첩된 객체/배열까지 포함해 (키, 문자열 값) 목록을 수집
    private fun collectStrings(node: Any?, key: String, out: MutableList<Pair<String, String>>) {
        when (node) {
            is JSONObject -> {
                val it = node.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    collectStrings(node.opt(k), k, out)
                }
            }
            is JSONArray -> for (i in 0 until node.length()) collectStrings(node.opt(i), key, out)
            is String -> out.add(key to node)
            else -> {}
        }
    }

    // 영상 키처럼 보이는 값: 8~24자, 영문 대/소문자 + 숫자가 모두 섞여 있음 (예: OK1jlJ6naKK)
    private fun looksLikeStreamKey(v: String): Boolean {
        if (!Regex("^[A-Za-z0-9_-]{8,24}$").matches(v)) return false
        return v.any { it.isUpperCase() } && v.any { it.isLowerCase() } && v.any { it.isDigit() }
    }

    private fun pickStreamData(item: JSONObject): String {
        val all = mutableListOf<Pair<String, String>>()
        collectStrings(item, "", all)

        // 1순위: m3u8이 들어간 완성 URL
        all.firstOrNull { it.second.startsWith("http") && it.second.contains(".m3u8") }
            ?.let { return it.second }

        // 2순위: 영상 키처럼 생긴 값 (이름/날짜/이미지 계열 필드는 제외)
        all.firstOrNull { (k, v) ->
            k.lowercase() !in nameKeys && skipKeys.none { s -> k.lowercase().contains(s) } && looksLikeStreamKey(v)
        }?.let { return it.second }

        // 3순위: 알려진 필드명
        return firstString(item, urlKeys)
    }

    // 경기 종류(category)를 한글 종목명으로 바꿈. 모르는 값은 영어 원문 그대로 표시
    private fun categoryLabel(item: JSONObject): String {
        val raw = item.optString("category").ifEmpty { item.optString("categoryName") }.trim()
        if (raw.isEmpty()) return ""
        return when (raw.lowercase().replace(CATEGORY_SEPARATOR_REGEX, "")) {
            "football", "soccer" -> "축구"
            "basketball" -> "농구"
            "baseball" -> "야구"
            "volleyball" -> "배구"
            "hockey", "icehockey" -> "하키"
            "tennis" -> "테니스"
            "americanfootball", "nfl" -> "미식축구"
            "lol", "esports", "leagueoflegends" -> "롤"
            "boxing" -> "복싱"
            "tv" -> "TV"
            else -> raw
        }
    }

    private fun parseEpisodes(jsonText: String): List<SEpisode> {
        val array = findArray(jsonText) ?: return emptyList()
        firstItemDebug = array.opt(0).toString().take(400)

        val list = mutableListOf<SEpisode>()
        var count = 1f
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val streamData = pickStreamData(item)
            if (streamData.isEmpty()) continue

            val baseTitle = firstString(item, nameKeys).ifEmpty { "실시간 경기 ${count.toInt()}" }
            val label = categoryLabel(item)
            val title = if (label.isNotEmpty()) "[$label] $baseTitle" else baseTitle

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

    // 동시에 두 번 실행되지 않게 하고, 1분 안에 다시 호출되면 이전 결과를 재사용
    @Synchronized
    private fun ensureCaptured() {
        if (capturedJson == null || System.currentTimeMillis() - lastCaptureTime > 60_000) {
            captureFromPage()
            lastCaptureTime = System.currentTimeMillis()
        }
    }

    @Synchronized
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun captureFromPage() {
        capturedJson = null
        capturedM3u8 = null
        candidateHeads = ""

        val pageUrl = livePageUrl
        val pageReferer = "$baseUrl/"
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

                        // 목록 추출에 필요 없는 채팅 위젯/이미지/폰트는 빈 응답으로 차단
                        if (host.endsWith("vchat24.com") || blockedAssets.matches(path)) {
                            return WebResourceResponse(
                                "text/plain",
                                "UTF-8",
                                ByteArrayInputStream(ByteArray(0)),
                            )
                        }

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

                webView.loadUrl(pageUrl, mutableMapOf("Referer" to pageReferer))
            } catch (e: Exception) {
                Log.d(tag, "webview error: ${e.message}")
                latch.countDown()
            }
        }

        latch.await(15, TimeUnit.SECONDS)
        // 목록 JSON에 m3u8 주소가 이미 들어 있으면 기다리지 않음 (영상 호스트 확보용 대기)
        var waited = 0
        while (capturedM3u8 == null && capturedJson?.contains(".m3u8") != true && waited < 6000) {
            Thread.sleep(250)
            waited += 250
        }

        handler.post {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }

        // 영상 호스트: 가로챈 m3u8 요청에서, 없으면 목록 JSON 안의 m3u8 주소에서 읽음
        val liveFromJson = capturedJson?.let {
            Regex("""https?://[^"\\\s]+\.m3u8[^"\\\s]*""").find(it.replace("\\/", "/"))?.value
        }
        (capturedM3u8 ?: liveFromJson)?.let { liveHost = Uri.parse(it).host }
        Log.d(tag, "iframeHost=$iframeHost liveHost=$liveHost json=${capturedJson?.length}")
    }

    // ================= 4. 실시간 경기 목록 =================
    private fun m3u8Episode(url: String) = SEpisode.create().apply {
        name = "실시간 라이브 채널 (자동감지)"
        episode_number = 1f
        this.url = "/play?stream_data=" + URLEncoder.encode(url, "UTF-8")
    }

    // 목록을 불러오지 못했을 때 원인을 보여주는 줄
    private fun debugEpisode(msg: String) = SEpisode.create().apply {
        name = "DEBUG: $msg"
        episode_number = -1f
        this.url = "/play?stream_data=debug"
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        ensureCaptured()

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

    // ================= 5. 로컬 프록시 =================
    // 플레이어(mpv)가 직접 요청하면 400을 받으므로, 플레이어는 127.0.0.1로 요청하고
    // 실제 요청은 앱(OkHttp)이 대신 보낸다. 재생목록 안의 주소도 모두 이 프록시로 돌린다.
    @Volatile private var proxyServer: ServerSocket? = null
    @Volatile private var proxyHeaders: Headers = Headers.Builder().build()
    private val proxyPool = Executors.newCachedThreadPool()

    // 재생목록에서 확인된 호스트만 프록시가 대신 요청하도록 허용
    private val allowedHosts: MutableSet<String> = ConcurrentHashMap.newKeySet()

    private fun ensureProxy(): Int {
        proxyServer?.let { if (!it.isClosed) return it.localPort }
        synchronized(this) {
            proxyServer?.let { if (!it.isClosed) return it.localPort }
            val ss = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
            proxyServer = ss
            Thread {
                while (!ss.isClosed) {
                    try {
                        val s = ss.accept()
                        proxyPool.execute { handleProxy(s) }
                    } catch (e: Exception) {
                        break
                    }
                }
            }.apply { isDaemon = true }.start()
            return ss.localPort
        }
    }

    private fun proxyUrl(port: Int, target: String): String =
        "http://127.0.0.1:$port/p?u=" + URLEncoder.encode(target, "UTF-8")

    // 재생목록 안의 주소(조각, 하위 목록, 키)를 모두 프록시 주소로 바꾼다
    private fun rewritePlaylist(base: String, body: String, port: Int): String {
        fun wrap(u: String): String {
            val abs = try {
                java.net.URI(base).resolve(u).toString()
            } catch (e: Exception) {
                u
            }
            try {
                allowedHosts.add(abs.toHttpUrl().host)
            } catch (e: Exception) {
                // 잘못된 주소는 무시
            }
            return proxyUrl(port, abs)
        }
        return body.lineSequence().joinToString("\n") { line ->
            val t = line.trim()
            when {
                t.isEmpty() -> line
                t.startsWith("#") ->
                    Regex("URI=\"([^\"]+)\"").replace(line) { m -> "URI=\"" + wrap(m.groupValues[1]) + "\"" }
                else -> wrap(t)
            }
        }
    }

    private fun handleProxy(s: Socket) {
        try {
            s.soTimeout = 30000
            val reader = BufferedReader(InputStreamReader(s.getInputStream()))
            val requestLine = reader.readLine() ?: return
            while (true) {
                val l = reader.readLine() ?: break
                if (l.isEmpty()) break
            }
            val enc = requestLine.substringAfter("u=", "").substringBefore(" ")
            val target = URLDecoder.decode(enc, "UTF-8")
            val out = s.getOutputStream()

            val targetHost = try { target.toHttpUrl().host } catch (e: Exception) { "" }
            if (targetHost !in allowedHosts) {
                out.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n".toByteArray())
                out.flush()
                return
            }

            val req = Request.Builder().url(target).headers(proxyHeaders).build()
            client.newCall(req).execute().use { res ->
                val ct = res.header("Content-Type") ?: ""
                val isPlaylist = target.substringBefore("?").endsWith(".m3u8") ||
                    ct.contains("mpegurl", true)

                if (isPlaylist && res.isSuccessful) {
                    val text = res.body?.string() ?: ""
                    val bytes = rewritePlaylist(target, text, s.localPort).toByteArray(Charsets.UTF_8)
                    out.write(
                        (
                            "HTTP/1.1 200 OK\r\n" +
                                "Content-Type: application/vnd.apple.mpegurl\r\n" +
                                "Content-Length: ${bytes.size}\r\n" +
                                "Connection: close\r\n\r\n"
                            ).toByteArray(),
                    )
                    out.write(bytes)
                } else {
                    val status = if (res.isSuccessful) "200 OK" else "${res.code} Error"
                    val type = ct.ifEmpty { "application/octet-stream" }
                    out.write(
                        ("HTTP/1.1 $status\r\nContent-Type: $type\r\nConnection: close\r\n\r\n").toByteArray(),
                    )
                    res.body?.byteStream()?.copyTo(out)
                }
                out.flush()
            }
        } catch (e: Exception) {
            Log.d(tag, "proxy error: ${e.message}")
        } finally {
            try {
                s.close()
            } catch (e: Exception) {
                // ignore
            }
        }
    }

    // ================= 6. 비디오 재생 =================
    private data class Candidate(
        val sub200: Boolean,
        val label: String,
        val url: String,
        val headers: Headers,
        val result: String,
    )

    private fun cookieHeader(url: String): String = try {
        client.cookieJar.loadForRequest(url.toHttpUrl()).joinToString("; ") { "${it.name}=${it.value}" }
    } catch (e: Exception) {
        ""
    }

    // Referer/Origin(/쿠키) 조합 후보. 확인된 xvqz+Origin을 맨 앞에 둠
    private fun headerVariants(url: String): List<Pair<String, Headers>> {
        val ua = headersBuilder().build()["User-Agent"]!!
        val iframeRef = iframeHost?.let { "https://$it/" }
        val cookie = cookieHeader(url)

        fun build(ref: String?, withOrigin: Boolean, withCookie: Boolean = false): Headers {
            val b = Headers.Builder().set("User-Agent", ua).set("Accept", "*/*")
            if (ref != null) {
                b.set("Referer", ref)
                if (withOrigin) b.set("Origin", ref.trimEnd('/'))
            }
            if (withCookie && cookie.isNotEmpty()) b.set("Cookie", cookie)
            return b.build()
        }

        val list = mutableListOf<Pair<String, Headers>>()
        list.add("xvqz+Origin" to build("https://xvqz.org/", true))
        if (iframeRef != null) list.add("iframe+Origin" to build(iframeRef, true))
        if (cookie.isNotEmpty()) list.add("xvqz+Origin+쿠키" to build("https://xvqz.org/", true, true))
        list.add("njtv+Origin" to build("$baseUrl/", true))
        list.add("UA만" to build(null, false))
        return list
    }

    // m3u8과 그 안의 첫 하위 주소(조각/변형 목록)까지 요청해 결과 코드를 문자열로 반환
    private fun probe(url: String, h: Headers): String {
        return try {
            val res = client.newCall(GET(url, h)).execute()
            val code = res.code
            val body = res.use { it.body?.string() ?: "" }
            if (code != 200 || !body.startsWith("#EXTM3U")) return "m3u8=$code"

            val next = body.lineSequence().map { it.trim() }
                .firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
                ?: return "m3u8=200"
            val subUrl = try {
                java.net.URI(url).resolve(next).toString()
            } catch (e: Exception) {
                next
            }
            val subCode = client.newCall(GET(subUrl, h)).execute().use { it.code }
            "m3u8=200 sub=$subCode"
        } catch (e: Exception) {
            "예외 ${e.message?.take(30)}"
        }
    }

    override fun videoListParse(response: Response): List<Video> {
        val data = response.request.url.queryParameter("stream_data") ?: ""
        if (data.isEmpty()) {
            throw Exception("stream_data 비어있음")
        }
        if (data == "debug") {
            throw Exception("원인 확인용 줄입니다. item=$firstItemDebug")
        }

        val mirrors = listOfNotNull(
            liveHost,
            "ol3ktizakokhjhnu.kjhsdfuie.work",
            "daxnb7e8nd4e0hdj.kjhsdfuie.work",
        ).distinct()

        val parsed = if (data.startsWith("http")) {
            try { data.toHttpUrl() } catch (e: Exception) { null }
        } else {
            null
        }

        val site = siteHost

        // 완성 URL이면 원래 호스트를 먼저, 이어서 다른 호스트로 바꾼 주소도 시도
        val playUrls: List<String> = when {
            parsed != null && parsed.host.endsWith(".kjhsdfuie.work") ->
                (listOf(parsed.host) + mirrors).distinct().map { h ->
                    if (h == parsed.host) data else parsed.newBuilder().host(h).build().toString()
                }
            parsed != null -> listOf(data)
            else -> mirrors.map { "https://$it/live/$data/playlist.m3u8?site=$site" }
        }

        fun hostTag(u: String): String = try {
            u.toHttpUrl().host.take(5)
        } catch (e: Exception) {
            "?"
        }

        val log = mutableListOf<String>()
        val ok = mutableListOf<Candidate>()

        for (u in playUrls) {
            for ((label, h) in headerVariants(u)) {
                val r = probe(u, h)
                log.add("${hostTag(u)}:${r.take(9)}")
                if (r.startsWith("m3u8=200")) {
                    ok.add(Candidate(r.contains("sub=200"), label, u, h, r))
                }
                // 하위 주소까지 통과하면 중단, 404면 헤더를 바꿔도 같으므로 다음 호스트로
                if (r.contains("sub=200") || r.startsWith("m3u8=404")) break
            }
            if (ok.isNotEmpty()) break
        }

        if (ok.isEmpty()) {
            val key = parsed?.encodedPath?.removePrefix("/live/")?.substringBefore("/") ?: data
            val all404 = log.isNotEmpty() && log.all { it.contains("m3u8=404") }
            throw Exception("[${key.take(14)}] " + (if (all404) "404 " else "") + log.joinToString(" | "))
        }

        val best = ok.sortedByDescending { it.sub200 }.first()

        // 로컬 프록시 (앱이 통과한 헤더로 대신 요청). 직접 재생은 플레이어에서 400이라 제외
        val port = ensureProxy()
        proxyHeaders = best.headers
        try {
            allowedHosts.add(best.url.toHttpUrl().host)
        } catch (e: Exception) {
            // 무시
        }
        val proxied = proxyUrl(port, best.url)
        return listOf(Video(proxied, "프록시 [${best.label}]", proxied, Headers.Builder().build()))
    }

    override fun videoUrlParse(response: Response): String = ""

    // ================= 7. 설정 화면 (주소 직접 지정) =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        fun summaryOf(current: String) =
            "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다.\n현재 주소: $current"

        val domainPref = EditTextPreference(screen.context).apply {
            key = PREF_DOMAIN_KEY
            title = "사이트 주소 직접 지정 (선택)"
            summary = summaryOf(baseUrl)
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 주소를 입력하세요. 예: https://njtv-02.com"
            setDefaultValue("")

            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                when {
                    input.isEmpty() -> {
                        summary = summaryOf(DEFAULT_BASE_URL)
                        lastCaptureTime = 0L
                        Toast.makeText(screen.context, "기본 주소로 되돌렸습니다.", Toast.LENGTH_SHORT).show()
                        true
                    }
                    DOMAIN_REGEX.matches(input) -> {
                        summary = summaryOf(input)
                        lastCaptureTime = 0L
                        Toast.makeText(screen.context, "주소가 변경되었습니다: $input", Toast.LENGTH_SHORT).show()
                        true
                    }
                    else -> {
                        Toast.makeText(
                            screen.context,
                            "올바른 주소 형식이 아닙니다 (예: https://njtv-02.com)",
                            Toast.LENGTH_LONG,
                        ).show()
                        false
                    }
                }
            }
        }
        screen.addPreference(domainPref)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val DEFAULT_BASE_URL = "https://njtv-01.com"
        private val DOMAIN_REGEX = Regex("""^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$""")
        private val CATEGORY_SEPARATOR_REGEX = Regex("""[\s_-]""")
    }
}
