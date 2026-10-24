package eu.kanade.tachiyomi.animeextension.ko.livesports

import android.app.Application
import android.content.SharedPreferences
import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * 필터 화면 맨 위의 현재 상태: 주소 · 자동 찾기 · 감시 점검 결과 · 최근 업데이트 내역(📝).
 * 점검 결과는 저장소 감시 작업이 올리는 status.json, 업데이트 내역은 저장소의 changelog.json 을
 * 백그라운드에서 받아 두었다가 보여 준다 (필터 화면을 여는 순간 네트워크를 기다리지 않음).
 */
internal object ExtStatus {
    private const val URL =
        "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/monitor-state/status.json"
    private const val PREF_JSON = "status_json"
    private const val NOTES_URL =
        "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/changelog.json"
    private const val PREF_NOTES = "notes_json"
    private const val REFRESH_MS = 20 * 60 * 1000L

    @Volatile
    private var json: JSONObject? = null

    @Volatile
    private var notesJson: JSONObject? = null

    @Volatile
    private var lastFetchAt = 0L

    private fun prefs(): SharedPreferences? = try {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication").invoke(null) as Application
        app.getSharedPreferences("insid_ext_status", 0)
    } catch (e: Throwable) {
        null
    }

    /** 20분에 한 번만 백그라운드로 새로 받음 */
    fun refresh() {
        val now = System.currentTimeMillis()
        if (now - lastFetchAt < REFRESH_MS) return
        lastFetchAt = now
        Thread {
            val client = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build()
            fun fetch(url: String, pref: String, set: (JSONObject) -> Unit) {
                try {
                    client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                        val text = res.body?.string().orEmpty()
                        if (res.isSuccessful && text.trim().startsWith("{")) {
                            set(JSONObject(text))
                            prefs()?.edit()?.putString(pref, text)?.apply()
                        }
                    }
                } catch (e: Throwable) {
                    // 다음 기회에 다시 받음
                }
            }
            fetch(URL, PREF_JSON) { json = it }
            fetch(NOTES_URL, PREF_NOTES) { notesJson = it }
        }.start()
    }

    private fun data(): JSONObject? = json ?: try {
        prefs()?.getString(PREF_JSON, null)?.let { JSONObject(it) }?.also { json = it }
    } catch (e: Throwable) {
        null
    }

    private fun notesData(): JSONObject? = notesJson ?: try {
        prefs()?.getString(PREF_NOTES, null)?.let { JSONObject(it) }?.also { notesJson = it }
    } catch (e: Throwable) {
        null
    }

    /** 그 소스의 최근 업데이트 내역 3개 ("📝 10.24 기본 주소 … 로 자동 변경") */
    fun notes(key: String): List<String> {
        refresh()
        val arr = notesData()?.optJSONObject("items")?.optJSONArray(key) ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val text = o.optString("t").trim()
            if (text.isEmpty()) null else "📝 ${o.optString("d").drop(5).replace('-', '.')} $text"
        }.take(3)
    }

    /** 상태 줄이 없는 소스: 업데이트 내역만 필터 맨 앞에 (내역이 없으면 그대로) */
    fun withNotes(key: String, base: AnimeFilterList): AnimeFilterList {
        val n = notes(key)
        if (n.isEmpty()) return base
        return AnimeFilterList(n.map { AnimeFilter.Header(it) } + AnimeFilter.Separator() + base.list)
    }

    private fun kst(iso: String): String = try {
        val inFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val outFmt = SimpleDateFormat("MM/dd HH:mm", Locale.KOREA).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }
        outFmt.format(inFmt.parse(iso.substring(0, 19))!!)
    } catch (e: Throwable) {
        ""
    }

    fun lines(key: String, baseUrl: String, autoDomain: Boolean?): List<String> {
        refresh()
        val host = baseUrl.substringAfter("://").trimEnd('/')
        val auto = when (autoDomain) {
            true -> " · 자동 찾기 켜짐"
            false -> " · 자동 찾기 꺼짐"
            null -> ""
        }
        val out = mutableListOf("📡 주소: $host$auto")
        val item = data()?.optJSONObject("items")?.optJSONObject(key)
        out.add(
            when {
                item != null && item.has("ok") -> {
                    val time = kst(item.optString("checkedAt"))
                    if (item.optBoolean("ok")) "🩺 점검: 정상 · $time" else "❌ 점검: 문제 · $time · ${item.optString("msg").take(40)}"
                }
                item != null && item.has("domain") ->
                    if (item.optString("domain") == "dead") "❌ 주소 확인: 접속 불가" else "🩺 주소 확인: 정상"
                else -> "🩺 점검: 정보 없음 (잠시 후 필터를 다시 열면 표시)"
            },
        )
        out.add("🛡 Cloudflare에 막히면: 메뉴 → WebView에서 열기로 한 번 통과")
        out.addAll(notes(key))
        return out
    }

    /** 상태 줄을 필터 목록 맨 앞에 붙임 */
    fun prepend(key: String, baseUrl: String, autoDomain: Boolean?, base: AnimeFilterList): AnimeFilterList =
        AnimeFilterList(lines(key, baseUrl, autoDomain).map { AnimeFilter.Header(it) } + AnimeFilter.Separator() + base.list)
}
