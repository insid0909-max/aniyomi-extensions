package eu.kanade.tachiyomi.animeextension.ko.tvroom

import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/**
 * 작품 페이지를 잠깐(기본 60초) 기억해 두는 장치.
 * 애니요미는 작품을 열 때 "작품 정보"와 "회차 목록"을 따로 요청하는데, 이 사이트들은 둘이 같은 페이지라
 * 같은 페이지를 두 번 받게 된다. 방금 받은 페이지를 다시 쓰면 요청이 절반으로 줄고 사이트 차단(403)도 덜 생긴다.
 * pathRegex 에 맞는 주소의 정상(200) GET 응답만 기억한다.
 */
internal class PageCache(private val pathRegex: Regex, private val ttlMs: Long = 60_000L) : Interceptor {
    private class Entry(val at: Long, val body: ByteArray, val contentType: String?, val finalUrl: String)

    private val map = LinkedHashMap<String, Entry>()

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (req.method != "GET" || !pathRegex.containsMatchIn(req.url.encodedPath)) return chain.proceed(req)
        val key = req.url.toString()
        val now = System.currentTimeMillis()
        synchronized(map) {
            map.entries.removeAll { now - it.value.at > ttlMs }
            map[key]
        }?.let { e ->
            return Response.Builder()
                .request(req.newBuilder().url(e.finalUrl).build())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(e.body.toResponseBody(e.contentType?.toMediaTypeOrNull()))
                .build()
        }
        val res = chain.proceed(req)
        if (res.code != 200) return res
        val bytes = res.body.bytes()
        val type = res.header("Content-Type")
        synchronized(map) {
            map[key] = Entry(now, bytes, type, res.request.url.toString())
            while (map.size > 20) map.remove(map.keys.first())
        }
        return res.newBuilder().body(bytes.toResponseBody(type?.toMediaTypeOrNull())).build()
    }
}
