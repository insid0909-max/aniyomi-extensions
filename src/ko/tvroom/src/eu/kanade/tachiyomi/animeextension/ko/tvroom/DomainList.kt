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

    /** 짧은 시간 제한 통신 (진짜 사이트 확인용) */
    val plainClient: OkHttpClient get() = CLIENT

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

    // ---------- 2026-11-13: 안내 페이지 주소 따라가기 ----------
    // 감시 작업이 매일 안내 페이지를 읽어 이 파일을 고치므로, 확장은 6시간마다(뒤에서) 파일에 적힌 주소를 봄.
    // 지금 주소와 같은 사이트 이름이고 번호가 더 크며, 휴대폰에서 진짜 사이트로 열릴 때만 자동 주소로 저장
    // → 다음 요청부터 그 주소(직접 넣은 주소도 DomainGuard.pick 이 번호를 비교해 고침)
    private val LAST_LOOK = java.util.concurrent.ConcurrentHashMap<String, Long>()

    private val NOTES = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** 필터 맨 위에 보일 마지막 주소 목록 확인 결과 (예: "11.13 14:00 · 같음") */
    fun note(key: String): String? = NOTES[key]

    private fun stamp(): String = java.text.SimpleDateFormat("MM.dd HH:mm", java.util.Locale.KOREA)
        .apply { timeZone = java.util.TimeZone.getTimeZone("Asia/Seoul") }.format(java.util.Date())

    fun followLater(
        key: String,
        sp: android.content.SharedPreferences?,
        prefKey: String,
        current: String,
        autoOn: Boolean,
        isReal: (String) -> Boolean,
    ) {
        if (sp == null) return
        val noteKey = "${prefKey}_listed_note"
        if (!NOTES.containsKey(key)) runCatching { sp.getString(noteKey, null) }.getOrNull()?.let { NOTES[key] = it }
        if (!autoOn) return
        val now = System.currentTimeMillis()
        if (now - (LAST_LOOK[key] ?: 0L) < 600_000) return
        LAST_LOOK[key] = now
        val atKey = "${prefKey}_listed_at"
        val at = runCatching { sp.getLong(atKey, 0L) }.getOrDefault(0L)
        if (now - at < 6 * 3600_000L) return
        Thread {
            fun save(msg: String) {
                val v = "${stamp()} · $msg"
                NOTES[key] = v
                runCatching { sp.edit().putString(noteKey, v).apply() }
            }
            try {
                runCatching { sp.edit().putLong(atKey, now).apply() }
                val cur = current.substringAfter("://").substringBefore('/').lowercase().removePrefix("www.")
                val h = host(key)
                when {
                    h == null -> save("목록 못 받음")
                    !newer(h.removePrefix("www."), cur) -> save("같음 (${h.removePrefix("www.")})")
                    isReal(h) -> {
                        DomainGuard.saveAuto(sp, prefKey, "https://$h")
                        save("새 주소 $h 로 바꿈")
                    }
                    else -> save("$h 가 아직 안 열려 그대로")
                }
            } catch (e: Throwable) {
                save("확인 실패")
            }
        }.start()
    }

    /** 같은 사이트 이름(숫자 뺀 가장 긴 이름 칸)이고 숫자들을 앞에서부터 비교해 더 크면 true (k07.kotbc2 > k05.kotbc2) */
    fun newer(a: String, b: String): Boolean {
        fun brand(h: String) = h.replace(Regex("""\d+"""), "").split('.').dropLast(1).maxByOrNull { it.length }.orEmpty()
        fun nums(h: String) = Regex("""\d+""").findAll(h).map { it.value.toInt() }.toList()
        if (a == b || brand(a).isEmpty() || brand(a) != brand(b)) return false
        val x = nums(a)
        val y = nums(b)
        for (i in 0 until minOf(x.size, y.size)) if (x[i] != y[i]) return x[i] > y[i]
        return x.size > y.size
    }

    /** 그 주소 첫 화면이 200 이고 넘어가지 않았으며 표시 글자가 모두 있으면 진짜 사이트 */
    fun realSite(host: String, ua: String, vararg markers: String): Boolean = try {
        val r = Request.Builder().url("https://$host/").header("User-Agent", ua).build()
        CLIENT.newCall(r).execute().use { res ->
            val body = if (res.code == 200 && res.request.url.host.removePrefix("www.") == host.removePrefix("www.")) res.peekBody(800_000).string() else ""
            body.isNotEmpty() && markers.all { body.contains(it) }
        }
    } catch (e: Throwable) {
        false
    }
}
