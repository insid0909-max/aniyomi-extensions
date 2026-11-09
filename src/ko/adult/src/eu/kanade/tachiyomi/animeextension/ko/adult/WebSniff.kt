package eu.kanade.tachiyomi.animeextension.ko.adult

import android.annotation.SuppressLint
import android.app.Application
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 숨은 화면(WebView)으로 작품 화면을 그대로 열고, 화면 안 플레이어가 요청한 m3u8 주소를 모음 (사이트 코드는 풀지 않음).
 * 그림·광고 요청은 빈 응답으로 막아 빨리 끝나게 하고, 재생이 안 시작되면 소리를 끈 채 재생 버튼을 눌러 봄
 * (숨은 화면에서 소리가 나 음량 막대가 뜨지 않게). 앱의 웹뷰와 쿠키를 같이 써서 Cloudflare 통과 쿠키도 그대로 씀.
 */
internal object WebSniff {
    private const val PLAY_SCRIPT =
        "(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play();}catch(e){}}" +
            "var b=document.querySelector('.plyr__control--overlaid,[data-plyr=play],.vjs-big-play-button,.jw-icon-display,button[aria-label*=Play]');" +
            "if(b)b.click();})();"
    private val IMAGE_PATH = Regex("""\.(?:png|jpe?g|gif|webp|avif|svg|ico)$""")
    private val BLOCKED = listOf("googletagmanager.com", "google-analytics.com", "doubleclick.net", "googlesyndication.com")

    class Result(val urls: List<String>, val lastPage: String)

    /** 처음 m3u8 을 찾은 뒤 1.5초 더 모아서 돌려줌 (주 목록과 화질별 목록이 따로 올 수 있음). 최대 timeoutSec 초 */
    @SuppressLint("SetJavaScriptEnabled")
    fun m3u8(url: String, referer: String, userAgent: String?, timeoutSec: Long = 25): Result {
        val found = Collections.synchronizedList(mutableListOf<String>())
        val first = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        var webViewRef: WebView? = null
        var lastPage = url

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
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, pageUrl: String, favicon: android.graphics.Bitmap?) {
                        lastPage = pageUrl
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val reqUrl = request.url.toString()
                        val path = request.url.path?.lowercase().orEmpty()
                        if (path.endsWith(".m3u8") && reqUrl !in found) {
                            found.add(reqUrl)
                            first.countDown()
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
        return Result(synchronized(found) { found.toList() }, lastPage)
    }
}
