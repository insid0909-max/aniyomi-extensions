package eu.kanade.tachiyomi.animeextension.ko.samsungtvplus

import eu.kanade.tachiyomi.animeextension.ko.livesports.LiveQuality
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import rx.Observable
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 삼성 TV 플러스 (삼성이 광고를 넣어 무료로 제공하는 공식 실시간 채널, 한국 채널).
 * - 채널 목록·편성: i.mjh.nz 가 삼성 공개 정보를 모아 둔 .channels.json 의 regions.kr
 *   (안 되면 같은 목록의 m3u 사본 dc-toki-aniyomi-media.pages.dev)
 * - 영상: jmp2.uk/stvp-{채널ID} 가 삼성 공식 영상 서버(akamaized·mediatailor) 주소로 넘겨 줌. 복사 방지(DRM) 없음
 * 채널마다 카드 하나(로고), 분류는 필터. 카드를 열면 설명에 지금·다음 편성, 회차는 "실시간" 하나.
 */
class SamsungTvPlus(private val fixedGroup: String? = null) : AnimeHttpSource(), ConfigurableAnimeSource {

    // 분류별 소스("삼성 TV 플러스 · 드라마" 등)는 그 분류 채널만 보여 주고, 설정은 기본 소스와 같이 씀
    override val name = if (fixedGroup == null) BASE_NAME else "$BASE_NAME · $fixedGroup"
    override val lang = "ko"
    override val supportsLatest = fixedGroup == null
    override val baseUrl = "https://www.samsungtvplus.com"

    private fun prefs(): android.content.SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication").invoke(null) as android.app.Application
        app.getSharedPreferences("source_${generateId(BASE_NAME, lang, versionId)}", 0)
    }.getOrNull()

    private class Ch(
        val id: String,
        val name: String,
        val chno: Int,
        val logo: String,
        val group: String,
        val description: String,
        val programs: List<Pair<Long, String>>,
    )

    // ================= 채널 목록 (30분 동안 기억, 분류별 소스와 함께 씀) =================
    private var cache: List<Ch>
        get() = sharedCache
        set(v) {
            sharedCache = v
        }

    private var cacheAt: Long
        get() = sharedCacheAt
        set(v) {
            sharedCacheAt = v
        }

    private fun channels(): List<Ch> {
        val now = System.currentTimeMillis()
        if (cache.isNotEmpty() && now - cacheAt < CACHE_MS) return cache
        val list = runCatching { fromJson() }.getOrDefault(emptyList()).ifEmpty { runCatching { fromM3u() }.getOrDefault(emptyList()) }
        if (list.isEmpty()) {
            if (cache.isNotEmpty()) return cache
            // 삼성 목록을 못 받아도 지상파(방송사 공식) 채널은 보여 줌
            return BROADCAST
        }
        // "실시간" 맨 앞에 지상파 채널 (방송사 홈페이지의 공식 무료 실시간, 라이브TV 와 같은 주소)
        cache = BROADCAST + list.sortedBy { it.chno }
        cacheAt = now
        return cache
    }

    private fun get(url: String): String =
        client.newCall(Request.Builder().url(url).headers(headers()).build()).execute().use { res ->
            if (!res.isSuccessful) throw Exception("HTTP ${res.code}")
            res.body.string()
        }

    /** {"regions":{"kr":{"channels":{ID:{name, chno, logo, description, group, programs:[[시작초, 제목]…]}}}}} */
    private fun fromJson(): List<Ch> {
        val kr = JSONObject(get(CHANNELS_JSON)).optJSONObject("regions")?.optJSONObject("kr")?.optJSONObject("channels")
            ?: return emptyList()
        return kr.keys().asSequence().mapNotNull { id ->
            val o = kr.optJSONObject(id) ?: return@mapNotNull null
            val p = o.optJSONArray("programs")
            val programs = (0 until (p?.length() ?: 0)).mapNotNull { i ->
                val a = p!!.optJSONArray(i) ?: return@mapNotNull null
                a.optLong(0) to a.optString(1)
            }
            Ch(
                id = id,
                name = o.optString("name").trim().ifEmpty { id },
                chno = o.optInt("chno", 9999),
                logo = o.optString("logo"),
                group = o.optString("group").trim().ifEmpty { "기타" },
                description = o.optString("description").trim(),
                programs = programs,
            )
        }.toList()
    }

    /** #EXTINF:-1 tvg-id="ID" tvg-logo="…" group-title="뉴스" tvg-chno="501",YTN */
    private fun fromM3u(): List<Ch> =
        get(CHANNELS_M3U).replace("\r", "").lines().filter { it.startsWith("#EXTINF") }.mapNotNull { line ->
            fun attr(k: String) = Regex("""$k="([^"]*)"""").find(line)?.groupValues?.get(1).orEmpty()
            val id = attr("tvg-id").ifEmpty { return@mapNotNull null }
            val name = line.substring(line.indexOf(',', line.lastIndexOf('"').coerceAtLeast(0)) + 1).trim()
            Ch(id, name.ifEmpty { id }, attr("tvg-chno").toIntOrNull() ?: 9999, attr("tvg-logo"), attr("group-title").ifEmpty { "기타" }, "", emptyList())
        }

    // ================= 편성 (지금 · 다음) =================
    private val timeFmt = SimpleDateFormat("HH:mm", Locale.KOREA).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }

    private fun nowNext(ch: Ch): Pair<String?, Pair<Long, String>?> {
        val now = System.currentTimeMillis() / 1000
        val sorted = ch.programs.sortedBy { it.first }
        val cur = sorted.lastOrNull { it.first <= now }?.second
        val next = sorted.firstOrNull { it.first > now }
        return cur to next
    }

    private fun scheduleLine(ch: Ch): String? {
        val (cur, next) = nowNext(ch)
        val parts = listOfNotNull(
            cur?.let { "지금: $it" },
            next?.let { "다음 ${synchronized(timeFmt) { timeFmt.format(Date(it.first * 1000)) }} ${it.second}" },
        )
        return parts.joinToString(" · ").ifEmpty { null }
    }

    // ================= 카드 (채널마다 하나, 고고티비처럼) =================
    private fun findChannel(id: String): Ch? = channels().firstOrNull { it.id == id }

    private fun idOf(url: String): String =
        "https://local.invalid$url".toHttpUrlOrNull()?.queryParameter("id").orEmpty()

    private fun matches(ch: Ch, q: String): Boolean {
        val k = q.replace(" ", "")
        return ch.name.replace(" ", "").contains(k, true) || (nowNext(ch).first?.replace(" ", "")?.contains(k, true) == true)
    }

    private fun card(ch: Ch): SAnime = SAnime.create().apply {
        // 애니요미는 서재 제목을 바꾸지 않으므로 제목은 채널 이름만 (편성은 설명에)
        title = ch.name
        thumbnail_url = ch.logo.ifEmpty { THUMB }
        status = SAnime.ONGOING
        url = "/ch?id=" + URLEncoder.encode(ch.id, "UTF-8")
    }

    private fun page(group: String, q: String): AnimesPage =
        AnimesPage(channels().filter { (group == ALL || it.group == group) && (q.isEmpty() || matches(it, q)) }.map { card(it) }, false)

    // ================= 인기·최신 탭 (탭 규칙으로 분류 지정) =================
    private fun tabGroup(key: String, default: String): String =
        prefs()?.getString(key, null)?.takeIf { it.isNotEmpty() } ?: default

    private fun latestDefault(): String = if (cache.any { it.group == LIVE_GROUP } || cache.isEmpty()) LIVE_GROUP else ALL

    override fun fetchPopularAnime(page: Int): Observable<AnimesPage> =
        Observable.fromCallable { page(fixedGroup ?: tabGroup(KEY_TAB_POPULAR, ALL), "") }

    override fun fetchLatestUpdates(page: Int): Observable<AnimesPage> =
        Observable.fromCallable { channels(); page(tabGroup(KEY_TAB_LATEST, latestDefault()), "") }

    // 검색: 채널 이름이나 지금 방송 중인 프로그램 이름 + 분류 필터 (+ 탭 규칙 저장)
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val sel = fixedGroup ?: filters.filterIsInstance<GroupFilter>().firstOrNull()?.let { f -> f.values.getOrNull(f.state) } ?: ALL
        if (fixedGroup == null) {
            val rule = filters.filterIsInstance<TabRuleFilter>().firstOrNull()?.state ?: 0
            prefs()?.edit()?.apply {
                when (rule) {
                    1 -> putString(KEY_TAB_POPULAR, sel)
                    2 -> putString(KEY_TAB_LATEST, sel)
                    3 -> remove(KEY_TAB_POPULAR)
                    4 -> remove(KEY_TAB_LATEST)
                    5 -> remove(KEY_TAB_POPULAR).remove(KEY_TAB_LATEST)
                }
            }?.apply()
        }
        return Observable.fromCallable { page(sel, query.trim()) }
    }

    override suspend fun getAnimeDetails(anime: SAnime): SAnime = withContext(Dispatchers.IO) {
        val ch = findChannel(idOf(anime.url))
        SAnime.create().apply {
            title = ch?.name ?: anime.title
            thumbnail_url = ch?.logo?.ifEmpty { null } ?: THUMB
            status = SAnime.ONGOING
            genre = ch?.group
            description = if (ch == null) {
                "채널 정보를 찾지 못했습니다. 목록에서 다시 열어 주세요."
            } else {
                listOfNotNull(
                    scheduleLine(ch)?.replace(" · 다음", "\n다음")?.let { "📡 $it" },
                    ch.description.ifEmpty { null },
                    if (ch.id in BROADCAST_URI) {
                        null
                    } else {
                        "${ch.group} · 채널 ${ch.chno}\n삼성 TV 플러스: 삼성이 광고를 넣어 무료로 제공하는 공식 실시간 채널입니다. 한국에서만 나오는 채널이 있을 수 있습니다."
                    },
                ).joinToString("\n\n")
            }
        }
    }

    // 회차 = "실시간" 하나 (옆에 지금·다음 편성)
    override suspend fun getEpisodeList(anime: SAnime): List<SEpisode> = withContext(Dispatchers.IO) {
        val ch = findChannel(idOf(anime.url)) ?: throw Exception("채널 정보를 찾지 못했습니다. 목록에서 다시 열어 주세요.")
        listOf(
            SEpisode.create().apply {
                name = "🔴 실시간"
                url = "/ch?id=" + URLEncoder.encode(ch.id, "UTF-8")
                episode_number = 1f
                scanlator = scheduleLine(ch)
            },
        )
    }

    // ================= 필터 (분류) =================
    private class GroupFilter(groups: Array<String>) : AnimeFilter.Select<String>("분류", groups)
    private class TabRuleFilter : AnimeFilter.Select<String>("인기/최신 탭 규칙", TAB_RULES)

    override fun getFilterList(): AnimeFilterList {
        if (fixedGroup != null) return AnimeFilterList(AnimeFilter.Header("검색어는 채널 이름이나 지금 방송 중인 프로그램 이름 ($fixedGroup 채널 안에서)"))
        // 화면을 그릴 때 인터넷을 쓰지 않도록, 받아 둔 목록이 있으면 그 분류, 없으면 기본 분류
        val known = cache.map { it.group }.distinct().ifEmpty { DEFAULT_GROUPS }
        return AnimeFilterList(
            AnimeFilter.Header("검색어는 채널 이름이나 지금 방송 중인 프로그램 이름"),
            GroupFilter((listOf(ALL) + known).toTypedArray()),
            AnimeFilter.Separator(),
            AnimeFilter.Header("분류를 고르고 아래 규칙을 고른 뒤 필터를 누르면 탭에 저장됩니다"),
            AnimeFilter.Header("현재 인기 탭: ${tabGroup(KEY_TAB_POPULAR, ALL)} · 최신 탭: ${tabGroup(KEY_TAB_LATEST, latestDefault())}"),
            TabRuleFilter(),
        )
    }

    // ================= 재생 =================
    private fun headers(): Headers = Headers.Builder().set("User-Agent", UA).build()

    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val id = "https://local.invalid${episode.url}".toHttpUrlOrNull()?.queryParameter("id").orEmpty()
        if (id.isEmpty()) throw Exception("잘못된 채널 주소")
        // 지상파 채널: 방송사 공식 웹 플레이어 주소에서 받음 (라이브TV 와 같은 방식)
        BROADCAST_URI[id]?.let { uri ->
            val (media, bh, label) = LIVE_TV.officialMedia(uri)
            val qualities = LiveQuality.variants(client, media, bh).map { (ht, u) -> Video(u, "$label ${ht}p", u, bh) }
            return@withContext LiveQuality.sort(prefs(), listOf(Video(media, "$label 자동", media, bh)) + qualities)
        }
        val h = headers()
        // jmp2.uk 가 삼성 공식 영상 주소로 넘겨 줌 → 넘어간 최종 주소를 씀
        val media = client.newCall(Request.Builder().url(STREAM + id).headers(h).build()).execute().use { res ->
            if (!res.isSuccessful) throw Exception("영상 주소를 받지 못했습니다 (HTTP ${res.code}). 한국에서만 나오는 채널이거나 잠시 중단된 채널일 수 있습니다.")
            res.request.url.toString()
        }
        val label = "삼성 공식"
        val qualities = LiveQuality.variants(client, media, h).map { (ht, u) -> Video(u, "$label ${ht}p", u, h) }
        LiveQuality.sort(prefs(), listOf(Video(media, "$label 자동", media, h)) + qualities)
    }

    // 쓰지 않는 요청형 함수 (목록·회차·재생은 위에서 직접 만듦)
    override fun popularAnimeRequest(page: Int): Request = throw UnsupportedOperationException()
    override fun popularAnimeParse(response: Response): AnimesPage = throw UnsupportedOperationException()
    override fun latestUpdatesRequest(page: Int): Request = throw UnsupportedOperationException()
    override fun latestUpdatesParse(response: Response): AnimesPage = throw UnsupportedOperationException()
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = throw UnsupportedOperationException()
    override fun searchAnimeParse(response: Response): AnimesPage = throw UnsupportedOperationException()
    override fun animeDetailsParse(response: Response): SAnime = throw UnsupportedOperationException()
    override fun episodeListParse(response: Response): List<SEpisode> = throw UnsupportedOperationException()
    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // 웹뷰 버튼: 삼성 TV 플러스 홈페이지
    override fun getAnimeUrl(anime: SAnime): String = baseUrl

    // 선호 화질: 분류별 소스에서 바꿔도 기본 소스 저장소에 같이 써서 모든 삼성 TV 플러스 소스가 같이 씀
    override fun setupPreferenceScreen(screen: androidx.preference.PreferenceScreen) {
        val shared = prefs()
        androidx.preference.ListPreference(screen.context).apply {
            key = KEY_QUALITY
            title = "선호 화질" + if (fixedGroup != null) " ($BASE_NAME 와 같이 씀)" else ""
            entries = QUALITIES
            entryValues = QUALITIES
            setDefaultValue(shared?.getString(KEY_QUALITY, null) ?: QUALITIES[0])
            summary = "%s\n채널이 여러 화질을 제공할 때 이 화질을 먼저 재생합니다."
            setOnPreferenceChangeListener { _, v ->
                shared?.edit()?.putString(KEY_QUALITY, v as String)?.apply()
                true
            }
        }.also(screen::addPreference)
    }

    companion object {
        private const val UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        private const val THUMB = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs/tv.png"
        private const val CHANNELS_JSON = "https://i.mjh.nz/SamsungTVPlus/.channels.json"
        private const val CHANNELS_M3U = "https://dc-toki-aniyomi-media.pages.dev/playlist/samsung-tv-plus.m3u"
        private const val STREAM = "https://jmp2.uk/stvp-"
        private const val ALL = "전체"
        private const val CACHE_MS = 30 * 60 * 1000L
        const val BASE_NAME = "삼성 TV 플러스"
        private const val LIVE_GROUP = "실시간"

        /** 분류별 소스로 따로 띄우는 분류 */
        val SOURCE_GROUPS = listOf("실시간", "드라마", "영화", "뉴스", "예능")
        private const val KEY_TAB_POPULAR = "stv_tab_popular"
        private const val KEY_TAB_LATEST = "stv_tab_latest"

        // LiveQuality 와 같은 키 (LiveQuality.sort 가 이 값을 읽음)
        private const val KEY_QUALITY = "pref_live_quality"
        private val QUALITIES = arrayOf<CharSequence>("자동", "1080p", "720p", "480p", "360p")
        private val TAB_RULES = arrayOf(
            "저장하지 않음 (필터 결과만 보기)",
            "고른 분류를 인기 탭에 저장",
            "고른 분류를 최신 탭에 저장",
            "인기 탭을 기본값(전체)으로",
            "최신 탭을 기본값(실시간)으로",
            "두 탭 모두 기본값으로",
        )

        // 지상파 채널 (방송사 홈페이지의 공식 무료 실시간). id → 라이브TV 의 "재생 방식:값"
        private val BROADCAST_URI = linkedMapOf(
            "bc-kbs1" to "kbs:11",
            "bc-kbs2" to "kbs:12",
            "bc-mbc" to "mbcmain:",
            "bc-sbs" to "sbsmain:S01",
        )
        private val BROADCAST_NAMES = mapOf("bc-kbs1" to "KBS1", "bc-kbs2" to "KBS2", "bc-mbc" to "MBC", "bc-sbs" to "SBS")
        private val BROADCAST: List<Ch> = BROADCAST_URI.keys.mapIndexed { i, id ->
            Ch(
                id = id,
                name = BROADCAST_NAMES.getValue(id),
                chno = -10 + i,
                logo = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs/ch_${id.removePrefix("bc-")}.png",
                group = LIVE_GROUP,
                description = "방송사 홈페이지에서 무료로 제공하는 공식 실시간 방송입니다 (라이브TV 와 같은 주소). 대부분 한국에서만 재생됩니다.",
                programs = emptyList(),
            )
        }

        // 지상파 채널 재생 주소는 라이브TV 소스의 방송사 공식 주소 받기를 그대로 씀
        private val LIVE_TV by lazy { eu.kanade.tachiyomi.animeextension.ko.livetv.LiveTv() }

        @Volatile
        private var sharedCache: List<Ch> = emptyList()

        @Volatile
        private var sharedCacheAt = 0L
        private val DEFAULT_GROUPS = listOf("뉴스", "예능", "드라마", "시사/교양", "영화", "실시간", "어린이", "음악", "라이프스타일", "쇼핑", "스포츠")
    }
}
