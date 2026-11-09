package eu.kanade.tachiyomi.animeextension.ko.tvroom

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 저장소의 주소 목록 파일(domains.json, 2026-11-03).
 * 확장이 스스로 새 주소를 못 찾을 때를 대비해, 저장소에 적어 둔 소스별 지금 주소를 주소 찾기 때 먼저 확인.
 * 파일에 적힌 주소도 진짜 사이트인지 확인한 뒤에만 쓴다(각 소스의 주소 찾기에서 확인).
 */
internal object DomainList {
    private const val URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/domains.json"

    @Volatile private var json: JSONObject? = null

    @Volatile private var fetchedAt = 0L

    private val CLIENT by lazy {
        OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    /** 파일에 적힌 그 소스의 주소(host). 파일은 5분 동안 기억 */
    fun host(key: String): String? {
        val now = System.currentTimeMillis()
        if (json == null || now - fetchedAt > 300_000) {
            fetchedAt = now
            try {
                val r = Request.Builder().url("$URL?t=${now / 60_000}").header("Cache-Control", "no-cache").build()
                CLIENT.newCall(r).execute().use { res ->
                    if (res.code == 200) json = JSONObject(res.body.string())
                }
            } catch (e: Throwable) {
                // 다음 기회에 다시 받음
            }
        }
        return json?.optJSONObject("domains")?.optJSONObject(key)?.optString("baseUrl")
            ?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }?.toHttpUrlOrNull()?.host?.lowercase()
    }
}
