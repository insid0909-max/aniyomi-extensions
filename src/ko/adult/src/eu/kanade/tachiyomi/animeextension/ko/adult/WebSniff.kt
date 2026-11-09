package eu.kanade.tachiyomi.animeextension.ko.adult

import android.annotation.SuppressLint
import android.app.Application
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.io.ByteArrayInputStream
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 숨은 화면(WebView)으로 작품 화면을 그대로 열고, 화면 안 플레이어가 요청한 m3u8 주소와 그때 보낸 머리글을 모음 (사이트 코드는 풀지 않음).
 * 그림·광고 요청은 빈 응답으로 막아 빨리 끝나게 하고, 재생이 안 시작되면 소리를 끈 채 재생 버튼을 눌러 봄
 * (숨은 화면에서 소리가 나 음량 막대가 뜨지 않게). 앱의 웹뷰와 쿠키를 같이 써서 Cloudflare 통과 쿠키도 그대로 씀.
 */
internal object WebSniff {
    private const val PLAY_SCRIPT =
        "(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.plyr__control--overlaid,[data-plyr=play],.vjs-big-play-button,.jw-icon-display,.art-state,.art-control-play,button[aria-label*=Play]');" +
            "if(b)b.click();})();"
    private val IMAGE_PATH = Regex("""\.(?:png|jpe?g|gif|webp|avif|svg|ico)$""")
    private val BLOCKED = listOf("googletagmanager.com", "google-analytics.com", "doubleclick.net", "googlesyndication.com")

    /** 잡힌 영상 주소 + 웹뷰가 그 요청에 보낸 머리글(Referer·Origin·User-Agent) */
    class Hit(val url: String, val headers: Map<String, String>)

    class Result(val hits: List<Hit>, val lastPage: String)

    /**
     * 처음 m3u8 을 찾은 뒤 1.5초 더 모아서 돌려줌 (주 목록과 화질별 목록이 따로 올 수 있음). 최대 timeoutSec 초.
     * block 에 맞는 주소는 기록만 하고 웹뷰가 실제로 받지는 않게 막음 (한 번 쓰는 표가 붙은 주소를 아껴 둠)
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun m3u8(url: String, referer: String, userAgent: String?, timeoutSec: Long = 25, block: Regex? = null): Result {
        val found = Collections.synchronizedList(mutableListOf<Hit>())
        val first = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        var webViewRef: WebView? = null
        var lastPage = url
        var webUa = userAgent

        handler.post {
            try {
                val context = Class.forName("android.app.ActivityThread")
                    .getMethod("currentApplication").invoke(null) as Application
                val webView = WebView(context)
                webViewRef = webView
                webView.settings.javaScriptEnabled = true
                webView.settings.domStorageEnabled = true
                webView.settings.mediaPlaybackRequiresUserGesture = false
                webView.settings.blockNetworkImage = true
                if (!userAgent.isNullOrBlank()) webView.settings.userAgentString = userAgent
                webUa = webView.settings.userAgentString
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, pageUrl: String, favicon: android.graphics.Bitmap?) {
                        lastPage = pageUrl
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val reqUrl = request.url.toString()
                        val path = request.url.path?.lowercase().orEmpty()
                        if (path.endsWith(".m3u8") && synchronized(found) { found.none { it.url == reqUrl } }) {
                            val hs = request.requestHeaders.orEmpty()
                                .filterKeys { it.equals("Referer", true) || it.equals("Origin", true) || it.equals("User-Agent", true) }
                            found.add(Hit(reqUrl, hs))
                            first.countDown()
                        }
                        if (block != null && block.containsMatchIn(reqUrl)) {
                            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                        }
                        val host = request.url.host.orEmpty()
                        if (BLOCKED.any { host.endsWith(it) } || IMAGE_PATH.containsMatchIn(path)) {
                            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }
                webView.loadUrl(url, mapOf("Referer" to referer))
            } catch (e: Throwable) {
                first.countDown()
            }
        }

        // 2초·6초·12초에 재생을 눌러 봄 (자동 재생이 안 되는 플레이어)
        val deadline = System.currentTimeMillis() + timeoutSec * 1000
        for (at in listOf(2L, 4L, 6L)) {
            if (first.await(at, TimeUnit.SECONDS)) break
            handler.post { runCatching { webViewRef?.evaluateJavascript(PLAY_SCRIPT, null) } }
        }
        val left = deadline - System.currentTimeMillis()
        if (left > 0 && first.await(left, TimeUnit.MILLISECONDS)) Thread.sleep(1500)
        handler.post {
            runCatching {
                webViewRef?.stopLoading()
                webViewRef?.destroy()
            }
        }
        val ua = webUa
        // 웹뷰가 User-Agent 를 머리글에 안 적어 보냈으면 웹뷰 설정 값을 넣음
        val hits = synchronized(found) { found.toList() }.map { h ->
            if (ua.isNullOrBlank() || h.headers.keys.any { it.equals("User-Agent", true) }) h else Hit(h.url, h.headers + ("User-Agent" to ua))
        }
        return Result(hits, lastPage)
    }

    /**
     * 잡힌 주소마다 머리글 조합을 바꿔 가며 실제로 열리는 첫 영상 목록 (웹뷰가 보낸 그대로 → Referer·Origin = 화면 주소 → Referer 만 → 없이).
     * 다 안 되면 null, fails 에 "주소 앞부분 HTTP 코드" 를 적음
     */
    fun firstWorking(
        client: OkHttpClient,
        hits: List<Hit>,
        pageOrigin: String,
        label: String,
        fails: MutableList<String>,
    ): List<Video>? {
        for (h in hits) {
            val ua = h.headers.entries.firstOrNull { it.key.equals("User-Agent", true) }?.value
            val variants = listOf(
                h.headers,
                listOfNotNull("Referer" to "$pageOrigin/", "Origin" to pageOrigin, ua?.let { "User-Agent" to it }).toMap(),
                listOfNotNull("Referer" to "$pageOrigin/", ua?.let { "User-Agent" to it }).toMap(),
                listOfNotNull(ua?.let { "User-Agent" to it }).toMap(),
            ).distinct()
            val codes = mutableListOf<String>()
            for (v in variants) {
                val headers = Headers.Builder().apply { v.forEach { (k, value) -> set(k, value) } }.build()
                HlsQuality.expandIfWorks(client, h.url, label, headers)?.let { return it }
                codes.add(code(client, h.url, headers))
            }
            val u = h.url.toHttpUrlOrNull()
            fails.add("${u?.host.orEmpty()}${u?.encodedPath.orEmpty().take(24)} ${codes.distinct().joinToString("/")}")
        }
        return null
    }

    /**
     * 진단용 (MissAV 403, 2026-11-09): 머리글 조합마다 재생 목록이 열리면 첫 영상 조각·열쇠까지 받아 보고
     * 화질 이름 뒤에 "머리글N · 조각 코드 · 열쇠 코드" 를 붙여 모두 돌려줌 (조각까지 열린 조합이 앞). 하나도 안 열리면 null
     */
    fun allWorkingProbed(
        client: OkHttpClient,
        hits: List<Hit>,
        pageOrigin: String,
        label: String,
        fails: MutableList<String>,
    ): List<Video>? {
        for (h in hits) {
            val ua = h.headers.entries.firstOrNull { it.key.equals("User-Agent", true) }?.value
            val variants = listOf(
                h.headers,
                listOfNotNull("Referer" to "$pageOrigin/", "Origin" to pageOrigin, ua?.let { "User-Agent" to it }).toMap(),
                listOfNotNull("Referer" to "$pageOrigin/", ua?.let { "User-Agent" to it }).toMap(),
                listOfNotNull("Referer" to "$pageOrigin/").toMap(),
            ).distinct()
            val codes = mutableListOf<String>()
            val ok = mutableListOf<Pair<Boolean, List<Video>>>()
            variants.forEachIndexed { n, v ->
                val headers = Headers.Builder().apply { v.forEach { (k, value) -> set(k, value) } }.build()
                val vids = HlsQuality.expandIfWorks(client, h.url, label, headers)
                if (vids == null) {
                    codes.add(code(client, h.url, headers))
                    return@forEachIndexed
                }
                val (good, text) = probe(client, h.url, headers)
                ok.add(good to vids.map { Video(it.url, "${it.quality} · 머리글${n + 1} · $text", it.videoUrl, it.headers) })
            }
            if (ok.isNotEmpty()) return ok.sortedByDescending { it.first }.flatMap { it.second }
            val u = h.url.toHttpUrlOrNull()
            fails.add("${u?.host.orEmpty()}${u?.encodedPath.orEmpty().take(24)} ${codes.distinct().joinToString("/")}")
        }
        return null
    }

    private val KEY_URI = Regex("""#EXT-X-KEY:[^\n]*URI="([^"]+)"""")

    /** 재생 목록(화질 묶음이면 첫 화질) → 첫 조각·열쇠를 같은 머리글로 받아 본 결과 */
    private fun probe(client: OkHttpClient, m3u8: String, headers: Headers): Pair<Boolean, String> = runCatching {
        fun text(u: String) = client.newCall(GET(u, headers)).execute().use { it.request.url to it.body.string() }
        var (base, body) = text(m3u8)
        if (body.contains("#EXT-X-STREAM-INF")) {
            val v = body.lines().map { it.trim() }.firstOrNull { it.isNotEmpty() && !it.startsWith("#") } ?: return@runCatching false to "목록 비어 있음"
            val next = base.resolve(v)?.toString() ?: return@runCatching false to "목록 주소 이상"
            text(next).let {
                base = it.first
                body = it.second
            }
        }
        val seg = body.lines().map { it.trim() }.firstOrNull { it.isNotEmpty() && !it.startsWith("#") }?.let { base.resolve(it)?.toString() }
        val key = KEY_URI.find(body)?.groupValues?.get(1)?.let { base.resolve(it)?.toString() }
        fun c(u: String) = client.newCall(GET(u, headers.newBuilder().set("Range", "bytes=0-1").build())).execute().use { it.code }
        val sc = seg?.let { c(it) }
        val kc = key?.let { c(it) }
        val good = sc != null && sc in 200..299 && (kc == null || kc in 200..299)
        good to listOfNotNull(sc?.let { "조각 $it" } ?: "조각 없음", kc?.let { "열쇠 $it" }).joinToString(" · ")
    }.getOrElse { false to "확인 실패 ${it.javaClass.simpleName}" }

    private fun code(client: OkHttpClient, url: String, headers: Headers): String = runCatching {
        client.newCall(GET(url, headers)).execute().use { it.code.toString() }
    }.getOrDefault("연결 실패")
}
