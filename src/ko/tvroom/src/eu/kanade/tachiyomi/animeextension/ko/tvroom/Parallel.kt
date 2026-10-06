package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.net.Uri
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * 서로 기다릴 필요 없는 요청(다른 서버 영상, 후보 주소 확인 등)을 동시에 처리해 재생 시작을 앞당긴다.
 * 사이트 페이지 요청은 SiteRateLimit 가 간격을 지켜 주므로 사이트에 한꺼번에 몰리지 않는다.
 */
internal object Parallel {
    private val POOL = Executors.newCachedThreadPool { r -> Thread(r, "tvroom-parallel").apply { isDaemon = true } }

    fun <T> start(f: () -> T): Future<T> = POOL.submit(Callable { f() })

    /** 결과를 순서대로, 실패·시간 초과·null 은 빼고 */
    fun <T, R : Any> mapNotNull(items: List<T>, timeoutMs: Long = 15_000L, f: (T) -> R?): List<R> {
        val until = System.currentTimeMillis() + timeoutMs
        return items.map { start { f(it) } }.mapNotNull { fu ->
            runCatching { fu.get((until - System.currentTimeMillis()).coerceAtLeast(1L), TimeUnit.MILLISECONDS) }
                .getOrNull()
        }
    }

    /** 시간 안에 끝나면 결과, 아니면 기본값 (늦은 작업은 기다리지 않음) */
    fun <T> Future<T>.getOr(timeoutMs: Long, default: T): T =
        runCatching { get(timeoutMs.coerceAtLeast(1L), TimeUnit.MILLISECONDS) }.getOrDefault(default)
}

/** 숨은 화면(WebView)에서 영상 주소 찾기에 필요 없는 요청(광고·분석·글꼴·그림)을 막아 로딩을 줄임 */
internal object SniffBlock {
    private val HOSTS = listOf(
        "googletagmanager.com",
        "google-analytics.com",
        "cloudflareinsights.com",
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adservice.google.com",
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "facebook.net",
        "clarity.ms",
        "hotjar.com",
    )
    private val EXTS = listOf(".woff", ".woff2", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico")

    fun blocked(uri: Uri): Boolean {
        val host = uri.host ?: return false
        val path = uri.path?.lowercase() ?: ""
        return HOSTS.any { host.endsWith(it) } || EXTS.any { path.endsWith(it) }
    }
}
