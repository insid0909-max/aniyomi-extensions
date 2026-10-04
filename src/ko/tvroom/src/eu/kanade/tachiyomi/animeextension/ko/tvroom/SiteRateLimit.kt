package eu.kanade.tachiyomi.animeextension.ko.tvroom

import okhttp3.Interceptor
import okhttp3.Response

/**
 * 사이트 주소(번호가 바뀌어도 같은 사이트)로 가는 요청 사이에 최소 간격을 둔다.
 * 한꺼번에 많이 요청하면 사이트가 접속을 막는(403) 것을 줄이기 위함. 영상·이미지 서버는 제한하지 않음.
 */
internal class SiteRateLimit(private val hostRegex: Regex, private val minGapMs: Long) : Interceptor {
    private var last = 0L

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (hostRegex.matches(req.url.host)) {
            synchronized(this) {
                val wait = last + minGapMs - System.currentTimeMillis()
                if (wait > 0) Thread.sleep(wait)
                last = System.currentTimeMillis()
            }
        }
        return chain.proceed(req)
    }
}
