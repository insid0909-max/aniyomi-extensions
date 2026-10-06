package eu.kanade.tachiyomi.animeextension.ko.tvroom

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/**
 * 사이트 페이지 요청(GET)이 연결 끊김·시간 초과로 실패하면 잠깐 쉬고 한 번 더 시도한다.
 * 순간적인 접속 불안정 때문에 영상 찾기가 바로 실패하는 것을 줄이기 위함. 영상·이미지 서버는 건드리지 않음.
 */
internal class RetryOnce(private val hostRegex: Regex, private val waitMs: Long = 700L) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (req.method != "GET" || !hostRegex.matches(req.url.host)) return chain.proceed(req)
        return try {
            chain.proceed(req)
        } catch (e: IOException) {
            if (chain.call().isCanceled()) throw e
            Thread.sleep(waitMs)
            chain.proceed(req)
        }
    }
}
