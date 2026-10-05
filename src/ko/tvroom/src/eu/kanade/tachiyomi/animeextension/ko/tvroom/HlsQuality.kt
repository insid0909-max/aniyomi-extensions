package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.content.SharedPreferences
import androidx.preference.ListPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.OkHttpClient

/**
 * 영상 화질 나누기 + 선호 화질.
 * HLS 마스터 목록(m3u8)에 1080p·720p 같은 화질이 여러 개 있으면 각각 따로 고를 수 있게 나누고,
 * 설정에서 고른 화질을 맨 앞에 둔다. 화질이 하나뿐이거나 읽지 못하면 원래 영상 그대로.
 */
internal object HlsQuality {
    private const val PREF_KEY = "pref_quality"
    private const val AUTO = "자동"
    private val CHOICES = arrayOf<CharSequence>(AUTO, "1080p", "720p", "480p", "360p")
    private val STREAM_REGEX = Regex("""#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)""")
    private val HEIGHT_REGEX = Regex("""RESOLUTION=\d+x(\d+)""")

    /** label 예: "티비착 (HLS)" → "티비착 (HLS) 자동", "티비착 (HLS) 1080p" … */
    fun expand(client: OkHttpClient, url: String, label: String, headers: Headers): List<Video> {
        val auto = Video(url, "$label $AUTO", url, headers)
        if (!url.contains(".m3u8")) return listOf(Video(url, label, url, headers))
        val variants = runCatching {
            client.newCall(GET(url, headers)).execute().use { res ->
                if (!res.isSuccessful) return@use emptyList()
                val body = res.body.string().replace("\r", "")
                val base = res.request.url
                STREAM_REGEX.findAll(body).mapNotNull { m ->
                    val height = HEIGHT_REGEX.find(m.groupValues[1])?.groupValues?.get(1) ?: return@mapNotNull null
                    val u = base.resolve(m.groupValues[2].trim())?.toString() ?: return@mapNotNull null
                    height.toInt() to u
                }.distinctBy { it.first }.sortedByDescending { it.first }.toList()
            }
        }.getOrDefault(emptyList())
        if (variants.size < 2) return listOf(Video(url, label, url, headers))
        return listOf(auto) + variants.map { (h, u) -> Video(u, "$label ${h}p", u, headers) }
    }

    /** 이 헤더로 영상 주소가 실제로 열리는지 (m3u8 이면 내용까지 확인) */
    fun works(client: OkHttpClient, url: String, headers: Headers): Boolean = runCatching {
        client.newCall(GET(url, headers)).execute().use { res ->
            if (!res.isSuccessful) return@use false
            if (!url.contains(".m3u8")) return@use true
            res.body.source().peek().readUtf8(16).trimStart().startsWith("#EXTM3U")
        }
    }.getOrDefault(false)

    /** 선호 화질을 맨 앞으로 (같은 화질 안에서는 원래 순서 유지) */
    fun sort(p: SharedPreferences?, videos: List<Video>): List<Video> {
        val want = p?.getString(PREF_KEY, AUTO) ?: AUTO
        return videos.sortedByDescending { it.quality.endsWith(" $want") }
    }

    fun addPreference(screen: PreferenceScreen) {
        ListPreference(screen.context).apply {
            key = PREF_KEY
            title = "선호 화질"
            entries = CHOICES
            entryValues = CHOICES
            setDefaultValue(AUTO)
            summary = "%s\n영상이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다."
        }.also(screen::addPreference)
    }
}
