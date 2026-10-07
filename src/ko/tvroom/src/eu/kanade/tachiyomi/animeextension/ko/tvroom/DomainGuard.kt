package eu.kanade.tachiyomi.animeextension.ko.tvroom

import okhttp3.Interceptor
import okhttp3.Response

/** 사이트 주소 번호 다루기 (wfwf512.com → 512, www.goodtoon006.com → 6, 002.bookkor.com → 2) */
internal object DomainGuard {
    private val LAST_NUM = Regex("""(\d+)(?!.*\d)""")

    fun hostNumber(urlOrHost: String): Int {
        val host = urlOrHost.substringAfter("://").substringBefore('/').removePrefix("www.")
        return LAST_NUM.find(host.substringBeforeLast('.'))?.value?.toIntOrNull() ?: 0
    }

    /** 저장된 주소가 확장 업데이트로 바뀐 기본 주소보다 옛 번호면 기본 주소를 씀 */
    fun preferDefault(saved: String, default: String): String =
        if (hostNumber(saved) in 1 until hostNumber(default)) default else saved
}

/**
 * 옛 주소가 끊기지 않고 "접속 주소 안내" 페이지(새 주소 링크만 있는 작은 페이지)를 보여 주는 경우,
 * 거기 적힌 더 큰 번호의 같은 사이트 주소가 진짜 사이트(marker 가 보임)면 그 주소로 같은 요청을 다시 보냄.
 * 바깥 가로채기(smartIntercept 등)가 바뀐 최종 주소를 저장하므로 다음부터는 새 주소로 바로 감.
 */
internal class NoticeFollow(private val hostRegex: Regex, private val marker: String) : Interceptor {
    private val plain by lazy {
        okhttp3.OkHttpClient.Builder()
            .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(8, java.util.concurrent.TimeUnit.SECONDS)
            .callTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
            .build()
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val res = chain.proceed(req)
        val host = req.url.host
        if (req.method != "GET" || res.code != 200 || !hostRegex.matches(host)) return res
        if (IMAGE_PATH.containsMatchIn(req.url.encodedPath)) return res
        val peek = try {
            String(res.peekBody(MAX_BYTES).bytes(), Charsets.ISO_8859_1)
        } catch (e: Exception) {
            return res
        }
        if (peek.length >= MAX_BYTES || peek.contains(marker)) return res
        val cur = DomainGuard.hostNumber(host)
        val family = familyRegex(host) ?: return res
        val targets = family.findAll(peek).map { it.value.lowercase() }
            .filter { hostRegex.matches(it) && DomainGuard.hostNumber(it) > cur }
            .distinct().sortedByDescending { DomainGuard.hostNumber(it) }.toList()
        val ua = req.header("User-Agent")
        for (t in targets) {
            val target = listOf(t, if (host.startsWith("www.") && !t.startsWith("www.")) "www.$t" else null)
                .firstOrNull { it != null && isReal(it, ua) } ?: continue
            res.close()
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(target).build()).build())
        }
        return res
    }

    private fun isReal(host: String, ua: String?): Boolean = try {
        val b = okhttp3.Request.Builder().url("https://$host/")
        if (ua != null) b.header("User-Agent", ua)
        plain.newCall(b.build()).execute().use { r ->
            r.code == 200 && hostRegex.matches(r.request.url.host) &&
                String(r.peekBody(1_000_000).bytes(), Charsets.ISO_8859_1).contains(marker)
        }
    } catch (e: Exception) {
        false
    }

    /** "www.goodtoon006.com" → goodtoon(\d+)\.[a-z]{2,6} 처럼 번호만 바뀌는 같은 사이트 주소 모양 */
    private fun familyRegex(host: String): Regex? {
        val h = host.removePrefix("www.")
        val head = h.substringBeforeLast('.')
        val m = Regex("""(\d+)(?!.*\d)""").find(head) ?: return null
        val pre = Regex.escape(head.substring(0, m.range.first))
        val post = Regex.escape(head.substring(m.range.last + 1))
        return Regex("""(?:www\.)?$pre\d+$post\.[a-z]{2,6}""", RegexOption.IGNORE_CASE)
    }

    private companion object {
        const val MAX_BYTES = 30_000L
        val IMAGE_PATH = Regex("""\.(?:jpe?g|png|webp|gif|avif|bmp)$""", RegexOption.IGNORE_CASE)
    }
}
