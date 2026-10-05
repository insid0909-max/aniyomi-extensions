package eu.kanade.tachiyomi.animeextension.ko.livesports

import android.content.SharedPreferences
import androidx.preference.ListPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.OkHttpClient

/**
 * 중계 화질 나누기 + 선호 화질 (실시간스포츠·실시간스포츠2 공통).
 * 중계 m3u8 이 여러 화질(1080p·720p…)을 담은 목록이면 화질별 주소를 돌려주고,
 * 설정에서 고른 화질의 영상을 맨 앞에 둔다. 화질이 하나뿐이거나 읽지 못하면 빈 목록.
 */
internal object LiveQuality {
    private const val PREF_KEY = "pref_live_quality"
    private const val AUTO = "자동"
    private val CHOICES = arrayOf<CharSequence>(AUTO, "1080p", "720p", "480p", "360p")
    private val STREAM_REGEX = Regex("""#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\s#][^\n]*)""")
    private val HEIGHT_REGEX = Regex("""RESOLUTION=\d+x(\d+)""")

    /** (세로 화소, 화질 주소) 목록, 높은 화질부터. 화질이 2개 이상일 때만 */
    fun variants(client: OkHttpClient, url: String, headers: Headers): List<Pair<Int, String>> {
        val list = runCatching {
            client.newCall(GET(url, headers)).execute().use { res ->
                if (!res.isSuccessful) return@use emptyList()
                val body = res.body.string().replace("\r", "")
                val base = res.request.url
                STREAM_REGEX.findAll(body).mapNotNull { m ->
                    val h = HEIGHT_REGEX.find(m.groupValues[1])?.groupValues?.get(1)?.toIntOrNull() ?: return@mapNotNull null
                    val u = base.resolve(m.groupValues[2].trim())?.toString() ?: return@mapNotNull null
                    h to u
                }.distinctBy { it.first }.sortedByDescending { it.first }.toList()
            }
        }.getOrDefault(emptyList())
        return if (list.size >= 2) list else emptyList()
    }

    /** 선호 화질(예: "720p")이 이름에 든 영상을 맨 앞으로. 자동이면 그대로 */
    fun sort(p: SharedPreferences?, videos: List<Video>): List<Video> {
        val want = p?.getString(PREF_KEY, AUTO) ?: AUTO
        if (want == AUTO) return videos
        return videos.sortedByDescending { it.quality.contains(" $want") }
    }

    fun addPreference(screen: PreferenceScreen) {
        ListPreference(screen.context).apply {
            key = PREF_KEY
            title = "선호 화질"
            entries = CHOICES
            entryValues = CHOICES
            setDefaultValue(AUTO)
            summary = "%s\n중계가 여러 화질을 제공할 때 이 화질을 먼저 재생합니다."
        }.also(screen::addPreference)
    }
}
