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
class SamsungTvPlus : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "삼성 TV 플러스"
    override val lang = "ko"
    override val supportsLatest = false
    override val baseUrl = "https://www.samsungtvplus.com"

    private fun prefs(): android.content.SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication").invoke(null) as android.app.Application
        app.getSharedPreferences("source_$id", 0)
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

    // ================= 채널 목록 (30분 동안 기억) =================
    @Volatile
    private var cache: List<Ch> = emptyList()

    @Volatile
    private var cacheAt = 0L

    private fun channels(): List<Ch> {
        val now = System.currentTimeMillis()
        if (cache.isNotEmpty() && now - cacheAt < CACHE_MS) return cache
        val list = runCatching { fromJson() }.getOrDefault(emptyList()).ifEmpty { runCatching { fromM3u() }.getOrDefault(emptyList()) }
        if (list.isEmpty()) {
            if (cache.isNotEmpty()) return cache
            throw Exception("삼성 TV 플러스 채널 목록을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
        }
        cache = list.sortedBy { it.chno }
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

    override fun fetchPopularAnime(page: Int): Observable<AnimesPage> = Observable.fromCallable { page(ALL, "") }

    // 검색: 채널 이름이나 지금 방송 중인 프로그램 이름 + 분류 필터
    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val sel = filters.filterIsInstance<GroupFilter>().firstOrNull()?.let { f -> f.values.getOrNull(f.state) } ?: ALL
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
                    "${ch.group} · 채널 ${ch.chno}\n삼성 TV 플러스: 삼성이 광고를 넣어 무료로 제공하는 공식 실시간 채널입니다. 한국에서만 나오는 채널이 있을 수 있습니다.",
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

    override fun getFilterList(): AnimeFilterList {
        // 화면을 그릴 때 인터넷을 쓰지 않도록, 받아 둔 목록이 있으면 그 분류, 없으면 기본 분류
        val known = cache.map { it.group }.distinct().ifEmpty { DEFAULT_GROUPS }
        return AnimeFilterList(
            AnimeFilter.Header("검색어는 채널 이름이나 지금 방송 중인 프로그램 이름"),
            GroupFilter((listOf(ALL) + known).toTypedArray()),
        )
    }

    // ================= 재생 =================
    private fun headers(): Headers = Headers.Builder().set("User-Agent", UA).build()

    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val id = "https://local.invalid${episode.url}".toHttpUrlOrNull()?.queryParameter("id").orEmpty()
        if (id.isEmpty()) throw Exception("잘못된 채널 주소")
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

    override fun setupPreferenceScreen(screen: androidx.preference.PreferenceScreen) {
        LiveQuality.addPreference(screen)
    }

    companion object {
        private const val UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        private const val THUMB = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs/tv.png"
        private const val CHANNELS_JSON = "https://i.mjh.nz/SamsungTVPlus/.channels.json"
        private const val CHANNELS_M3U = "https://dc-toki-aniyomi-media.pages.dev/playlist/samsung-tv-plus.m3u"
        private const val STREAM = "https://jmp2.uk/stvp-"
        private const val ALL = "전체"
        private const val CACHE_MS = 30 * 60 * 1000L
        private val DEFAULT_GROUPS = listOf("뉴스", "예능", "드라마", "시사/교양", "영화", "실시간", "어린이", "음악", "라이프스타일", "쇼핑", "스포츠")
    }
}
