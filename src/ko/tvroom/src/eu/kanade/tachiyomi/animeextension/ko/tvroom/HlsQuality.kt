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
    const val KEY = "pref_quality"
    const val AUTO = "자동"
    private const val PREF_KEY = KEY
    private val CHOICES = arrayOf<CharSequence>(AUTO, "1080p", "720p", "480p", "360p")
    private val HEIGHT_REGEX = Regex("""RESOLUTION=\d+x(\d+)""")
    private val URL_RES_REGEX = Regex("""(?<![0-9])(2160|1440|1080|720|576|480|360|240)[pP](?![0-9a-zA-Z])""")

    /** 주소에 "1080p" 같은 화질이 적혀 있으면 이름 뒤에 붙임 */
    fun withRes(label: String, url: String): String {
        val r = URL_RES_REGEX.find(java.net.URLDecoder.decode(url.substringBefore('?'), "UTF-8"))?.groupValues?.get(1)
        return if (r != null && !label.contains("${r}p")) "$label ${r}p" else label
    }

    /** label 예: "티비룸 (HLS)" → 화질 목록 분리 */
    fun expand(client: OkHttpClient, url: String, label: String, headers: Headers): List<Video> {
        if (!url.contains(".m3u8")) return listOf(Video(url, withRes(label, url), url, headers))

        val variants = runCatching {
            client.newCall(GET(url, headers)).execute().use { res ->
                if (!res.isSuccessful) return@use emptyList()
                val lines = res.body.string().lines().map { it.trim() }
                val base = res.request.url
                val list = mutableListOf<Pair<Int, String>>()

                var currentHeight: Int? = null
                for (line in lines) {
                    if (line.startsWith("#EXT-X-STREAM-INF:")) {
                        currentHeight = HEIGHT_REGEX.find(line)?.groupValues?.get(1)?.toIntOrNull() ?: 720
                    } else if (currentHeight != null && line.isNotEmpty() && !line.startsWith("#")) {
                        // #EXT-X-STREAM-INF 바로 다음 줄만 화질 주소 (단일 화질 목록의 영상 조각 주소는 제외)
                        val subUrl = base.resolve(line)?.toString() ?: line
                        list.add(currentHeight to subUrl)
                        currentHeight = null
                    }
                }
                list.distinctBy { it.first }.sortedByDescending { it.first }
            }
        }.getOrDefault(emptyList())

        // 마스터 플레이리스트가 아닌 단일(VOD) m3u8이거나 서브 스트림을 못 찾은 경우
        if (variants.isEmpty()) {
            return listOf(Video(url, withRes(label, url), url, headers))
        }

        // 서브 스트림 목록 생성 (서브 스트림 URL로 직접 재생해야 Live로 오인하지 않고 0:00부터 재생됨)
        val videoList = variants.map { (h, u) ->
            Video(u, "$label ${h}p", u, headers)
        }.toMutableList()

        // 첫 번째(최고화질) 항목 뒤에 자동 선택용 마스터 URL을 옵션으로 추가
        videoList.add(Video(url, "$label $AUTO", url, headers))

        return videoList
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
        return videos.sortedByDescending { it.quality.endsWith(" $want") || it.quality.contains(" $want ") }
    }

    fun addPreference(screen: PreferenceScreen, onChange: ((String) -> Unit)? = null) {
        ListPreference(screen.context).apply {
            key = PREF_KEY
            title = "선호 화질"
            entries = CHOICES
            entryValues = CHOICES
            setDefaultValue(AUTO)
            summary = "%s\n영상이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다."
            if (onChange != null) {
                setOnPreferenceChangeListener { _, v ->
                    onChange(v as String)
                    true
                }
            }
        }.also(screen::addPreference)
    }
}
