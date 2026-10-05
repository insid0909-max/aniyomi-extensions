package eu.kanade.tachiyomi.animeextension.ko.livetv

import eu.kanade.tachiyomi.animeextension.ko.livesports.LiveQuality
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimeUpdateStrategy
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
import rx.Observable
import java.net.URLEncoder

/**
 * 라이브TV: 방송사들이 자기 홈페이지에서 무료로 틀어 주는 실시간 채널 모음.
 * (MBC 엠빅라이브 24시, SBS·KBS 24시 정주행, 본방송, 지역·종교·공공 채널)
 * 재생 직전에 각 방송사 공식 웹 플레이어가 쓰는 주소에 물어 영상 주소를 받는다. 한국에서만 열리는 방송이 많다.
 * 채널 목록은 확장 안에 들어 있어서 목록·회차는 인터넷 요청 없이 바로 뜬다.
 */
class LiveTv : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "라이브TV"
    override val lang = "ko"
    override val supportsLatest = false
    override val baseUrl = "https://onair.kbs.co.kr"

    private fun prefs(): android.content.SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication").invoke(null) as android.app.Application
        app.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    private class Ch(val group: String, val name: String, val uri: String)

    // ================= 카드 (방송 묶음) =================
    private fun card(group: String, q: String = ""): SAnime = SAnime.create().apply {
        val count = channels(group, q).size
        title = (if (q.isNotEmpty()) "🔎 \"$q\"" else GROUPS.getValue(group)) + " · ${count}채널"
        thumbnail_url = THUMB
        status = SAnime.ONGOING
        // 채널 목록은 고정이라 서재 업데이트 때 다시 확인하지 않음
        update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
        url = "/live?g=$group" + if (q.isNotEmpty()) "&q=" + URLEncoder.encode(q, "UTF-8") else ""
    }

    private fun channels(group: String, q: String): List<Ch> = CHANNELS.filter {
        (group == "all" || it.group == group) && (q.isEmpty() || it.name.replace(" ", "").contains(q.replace(" ", ""), true))
    }

    private fun params(url: String): Pair<String, String> {
        val u = "https://local.invalid$url".toHttpUrlOrNull()
        return (u?.queryParameter("g") ?: "all") to u?.queryParameter("q").orEmpty()
    }

    override fun fetchPopularAnime(page: Int): Observable<AnimesPage> =
        Observable.just(AnimesPage(GROUPS.keys.filter { it != "all" }.map { card(it) }, false))

    override fun fetchSearchAnime(page: Int, query: String, filters: AnimeFilterList): Observable<AnimesPage> {
        val q = query.trim()
        if (q.isEmpty()) return fetchPopularAnime(page)
        return Observable.just(AnimesPage(listOf(card("all", q)), false))
    }

    override suspend fun getAnimeDetails(anime: SAnime): SAnime {
        val (g, q) = params(anime.url)
        return SAnime.create().apply {
            title = card(g, q).title
            thumbnail_url = THUMB
            status = SAnime.ONGOING
            update_strategy = AnimeUpdateStrategy.ONLY_FETCH_ONCE
            description = "방송사 홈페이지에서 무료로 제공하는 실시간 채널입니다.\n" +
                "대부분 한국에서만 재생됩니다. 회차(채널)를 누르면 재생 직전에 방송사에서 영상 주소를 받아 옵니다."
        }
    }

    override suspend fun getEpisodeList(anime: SAnime): List<SEpisode> {
        val (g, q) = params(anime.url)
        val list = channels(g, q)
        return list.mapIndexed { i, ch ->
            SEpisode.create().apply {
                name = ch.name
                url = "/ch?u=" + URLEncoder.encode(ch.uri, "UTF-8")
                episode_number = (list.size - i).toFloat()
                scanlator = if (g == "all") GROUPS[ch.group] else null
            }
        }
    }

    // ================= 재생 =================
    override suspend fun getVideoList(episode: SEpisode): List<Video> = withContext(Dispatchers.IO) {
        val uri = "https://local.invalid${episode.url}".toHttpUrlOrNull()?.queryParameter("u").orEmpty()
        val kind = uri.substringBefore(":")
        val arg = uri.substringAfter(":")
        val h = headersFor(kind)
        val media = if (kind == "direct") {
            arg
        } else {
            val api = apiUrl(kind, arg) ?: throw Exception("알 수 없는 채널: $uri")
            val body = client.newCall(Request.Builder().url(api).headers(h).build()).execute().use { it.body.string() }
            findMedia(body) ?: throw Exception(reason(body))
        }
        val label = LABELS[kind] ?: "라이브"
        val qualities = LiveQuality.variants(client, media, h).map { (ht, u) -> Video(u, "$label ${ht}p", u, h) }
        LiveQuality.sort(prefs(), listOf(Video(media, label, media, h)) + qualities)
    }

    /** 방송사 공식 웹 플레이어가 쓰는 주소 */
    private fun apiUrl(kind: String, arg: String): String? = when (kind) {
        "mbic" -> "https://mediaapi.imbc.com/Player/MbicPlayURLUtil?chid=$arg"
        "mbcmain" -> "https://mediaapi.imbc.com/Player/OnAirURLUtil?type=m&t=${System.currentTimeMillis()}"
        "sbsv" ->
            "https://apis.sbs.co.kr/play-api/1.0/onair/virtual/channel/$arg" +
                "?v_type=2&platform=pcweb&protocol=hls&ssl=Y&jwt-token=&rnd=${System.currentTimeMillis() % 1000}"
        "sbsmain" ->
            "https://apis.sbs.co.kr/play-api/1.0/onair/channel/$arg" +
                "?v_type=2&platform=pcweb&protocol=hls&ssl=Y&rscuse=&jwt-token=&sbsmain="
        "kbs" -> "https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/$arg"
        "cpbc" -> "https://apis.cpbc.co.kr/play-api/2.0/onair/channel/tv?jwt-token=&ssl=Y"
        else -> null
    }

    private fun headersFor(kind: String): Headers {
        val b = Headers.Builder().set("User-Agent", UA)
        when (kind) {
            "mbic", "mbcmain" -> b.set("Referer", "https://onair.imbc.com/MbicLive").set("Origin", "https://onair.imbc.com")
            "sbsv", "sbsmain" -> b.set("Referer", "https://www.sbs.co.kr/live/").set("Origin", "https://www.sbs.co.kr")
            "kbs" -> b.set("Referer", "https://onair.kbs.co.kr/")
            "cpbc" -> b.set("Referer", "https://www.cpbc.co.kr/")
        }
        return b.build()
    }

    /**
     * 응답 안에서 재생 주소 찾기 (JSON 이든 글자든). 응답 모양이 조금 바뀌어도 찾도록 m3u8 주소를 통째로 찾는다.
     * KBS 는 미리보기(preview) 주소도 함께 주므로 그것은 뒤로 미룬다.
     */
    private fun findMedia(body: String): String? {
        val text = body.replace("\\/", "/").replace("\\u0026", "&")
        val all = MEDIA_REGEX.findAll(text).map { it.value }.toList()
        return all.firstOrNull { !it.contains("preview", true) } ?: all.firstOrNull()
    }

    /** 재생 주소가 없을 때 방송사가 준 안내문 (해외 차단·저작권 등) */
    private fun reason(body: String): String {
        val msg = Regex("\"(?:overseas_text|onair_text|msg|message|Message)\"\\s*:\\s*\"([^\"]{2,120})\"")
            .findAll(body).map { it.groupValues[1] }.filter { it != "OK" }.toList()
        return "재생 주소를 받지 못했습니다" + if (msg.isNotEmpty()) " (${msg.distinct().joinToString(" / ")})" else " (한국에서만 재생되는 방송일 수 있습니다)"
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

    // 웹뷰 버튼: 방송사 온에어 화면
    override fun getAnimeUrl(anime: SAnime): String = when (params(anime.url).first) {
        "mbc" -> "https://onair.imbc.com/MbicLive"
        "sbs" -> "https://www.sbs.co.kr/live/"
        else -> "https://onair.kbs.co.kr/"
    }

    override fun setupPreferenceScreen(screen: androidx.preference.PreferenceScreen) {
        LiveQuality.addPreference(screen)
    }

    companion object {
        private const val UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        private const val THUMB = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs/tv.png"
        private val MEDIA_REGEX = Regex("""https?://[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*""")

        private val GROUPS = linkedMapOf(
            "main" to "📺 본방송",
            "mbc" to "🔴 MBC 24시 정주행",
            "sbs" to "🔵 SBS 24시 정주행",
            "kbs" to "🟦 KBS 24시 정주행",
            "etc" to "📡 지역·종교·공공",
            "all" to "📺 전체 채널",
        )

        private val LABELS = mapOf(
            "mbic" to "MBC 공식",
            "mbcmain" to "MBC 공식",
            "sbsv" to "SBS 공식",
            "sbsmain" to "SBS 공식",
            "kbs" to "KBS 공식",
            "cpbc" to "CPBC 공식",
            "direct" to "방송사 직접",
        )

        // 방송사 공식 주소만 (채널 목록 출처: 사용자가 준 라이브TV 앱의 공식 채널 목록. 비공식 재송출 주소는 뺌)
        private val CHANNELS = listOf(
            Ch("main", "KBS1", "kbs:11"),
            Ch("main", "KBS2", "kbs:12"),
            Ch("main", "MBC", "mbcmain:"),
            Ch("main", "SBS", "sbsmain:S01"),
            Ch("main", "TV조선", "direct:http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s3/playlist.m3u8"),
            Ch("main", "TV조선2", "direct:http://onair2.cdn.tvchosun.com/origin2/_definst_/tvchosun_s3/playlist.m3u8"),
            Ch("etc", "가톨릭평화방송 TV", "cpbc:"),
            Ch("etc", "KFN TV", "direct:http://mediaworks.dema.mil.kr:1935/live_edge/cudo.sdp/playlist.m3u8"),
            Ch("etc", "광주방송 KBC", "direct:https://vod.ikbc.co.kr/KBCTV/tv/playlist.m3u8"),
            Ch("etc", "울산방송 UBC", "direct:https://stream.ubc.co.kr/hls/ubctvstream/index.m3u8"),
            Ch("etc", "여의도순복음교회 FGTV", "direct:https://fgtvlive.fgtv.com/smil:fgtv.smil/playlist.m3u8"),
            Ch("mbc", "무한도전", "mbic:50"),
            Ch("mbc", "나 혼자 산다", "mbic:49"),
            Ch("mbc", "라디오스타", "mbic:48"),
            Ch("mbc", "무한상사", "mbic:76"),
            Ch("mbc", "무한도전 추격전", "mbic:94"),
            Ch("mbc", "진짜 사나이", "mbic:37"),
            Ch("mbc", "아빠 어디가", "mbic:38"),
            Ch("mbc", "거침없이 하이킥", "mbic:201"),
            Ch("mbc", "전원일기", "mbic:43"),
            Ch("mbc", "내 이름은 김삼순", "mbic:5"),
            Ch("mbc", "최고의 사랑", "mbic:3"),
            Ch("mbc", "별순검", "mbic:100"),
            Ch("mbc", "개와 늑대의 시간", "mbic:177"),
            Ch("mbc", "구암 허준", "mbic:61"),
            Ch("sbs", "런닝맨", "sbsv:S22"),
            Ch("mbc", "이산", "mbic:29"),
            Ch("mbc", "커피프린스 1호점", "mbic:31"),
            Ch("mbc", "선덕여왕", "mbic:34"),
            Ch("mbc", "대장금", "mbic:35"),
            Ch("mbc", "주몽", "mbic:108"),
            Ch("mbc", "복면가왕", "mbic:39"),
            Ch("mbc", "우리 결혼했어요", "mbic:26"),
            Ch("mbc", "무한도전 스포츠", "mbic:137"),
            Ch("mbc", "세바퀴", "mbic:144"),
            Ch("mbc", "놀러와", "mbic:145"),
            Ch("sbs", "TV 동물농장", "sbsv:S21"),
            Ch("sbs", "미운 우리 새끼", "sbsv:S23"),
            Ch("sbs", "백종원의 골목식당", "sbsv:S28"),
            Ch("sbs", "순풍산부인과", "sbsv:S24"),
            Ch("sbs", "내 남자의 여자", "sbsv:S25"),
            Ch("sbs", "야인시대", "sbsv:S26"),
            Ch("sbs", "올인", "sbsv:S27"),
            Ch("mbc", "어쩌다 발견한 하루", "mbic:6"),
            Ch("mbc", "아들과 딸", "mbic:9"),
            Ch("mbc", "제5공화국", "mbic:13"),
            Ch("mbc", "육남매", "mbic:14"),
            Ch("mbc", "영웅시대", "mbic:16"),
            Ch("mbc", "빛과 그림자", "mbic:18"),
            Ch("mbc", "궁", "mbic:19"),
            Ch("mbc", "오자룡이 간다", "mbic:20"),
            Ch("mbc", "오로라 공주", "mbic:21"),
            Ch("mbc", "옷소매 붉은 끝동", "mbic:24"),
            Ch("mbc", "두 번째 남편", "mbic:25"),
            Ch("mbc", "W-두 개의 세계", "mbic:27"),
            Ch("mbc", "종합병원", "mbic:30"),
            Ch("mbc", "뉴 논스톱", "mbic:32"),
            Ch("mbc", "동이", "mbic:33"),
            Ch("mbc", "허준", "mbic:40"),
            Ch("mbc", "상도", "mbic:41"),
            Ch("mbc", "보고 또 보고", "mbic:42"),
            Ch("mbc", "하이킥", "mbic:46"),
            Ch("mbc", "골든타임", "mbic:52"),
            Ch("mbc", "그대 그리고 나", "mbic:53"),
            Ch("mbc", "역적: 백성을 훔친 도적", "mbic:54"),
            Ch("mbc", "킬미힐미", "mbic:55"),
            Ch("mbc", "환상의 커플", "mbic:56"),
            Ch("mbc", "안녕, 프란체스카", "mbic:57"),
            Ch("mbc", "내 딸 금사월", "mbic:59"),
            Ch("mbc", "반짝반짝 빛나는", "mbic:60"),
            Ch("mbc", "마의", "mbic:64"),
            Ch("mbc", "그녀는 예뻤다", "mbic:66"),
            Ch("mbc", "다모", "mbic:70"),
            Ch("mbc", "인어아가씨", "mbic:71"),
            Ch("mbc", "네 멋대로 해라", "mbic:72"),
            Ch("mbc", "로망스", "mbic:73"),
            Ch("mbc", "사랑을 그대 품안에", "mbic:78"),
            Ch("mbc", "불어라 미풍아", "mbic:79"),
            Ch("mbc", "역도요정 김복주", "mbic:80"),
            Ch("mbc", "파스타", "mbic:84"),
            Ch("mbc", "백년의 유산", "mbic:86"),
            Ch("mbc", "왕꽃 선녀님", "mbic:92"),
            Ch("mbc", "수사반장", "mbic:98"),
            Ch("mbc", "히트", "mbic:99"),
            Ch("mbc", "납량특집극 M", "mbic:103"),
            Ch("mbc", "검법남녀", "mbic:104"),
            Ch("mbc", "별은 내 가슴에", "mbic:106"),
            Ch("mbc", "옥탑방 고양이", "mbic:109"),
            Ch("mbc", "왔다! 장보리", "mbic:117"),
            Ch("mbc", "내 뒤에 테리우스", "mbic:118"),
            Ch("mbc", "꼰대인턴", "mbic:119"),
            Ch("mbc", "연인", "mbic:120"),
            Ch("mbc", "피의 게임", "mbic:10"),
            Ch("mbc", "황금어장 무릎팍도사", "mbic:17"),
            Ch("mbc", "선을 넘는 녀석들", "mbic:23"),
            Ch("mbc", "심야괴담회", "mbic:28"),
            Ch("mbc", "신비한 TV 서프라이즈", "mbic:47"),
            Ch("mbc", "나는 가수다", "mbic:58"),
            Ch("mbc", "강호동의 천생연분", "mbic:87"),
            Ch("mbc", "대한외국인", "mbic:95"),
            Ch("mbc", "주간아이돌", "mbic:96"),
            Ch("mbc", "어서와 한국은 처음이지?", "mbic:101"),
            Ch("mbc", "god의 육아일기", "mbic:102"),
            Ch("mbc", "태어난 김에 세계일주1", "mbic:105"),
            Ch("kbs", "쌈, 마이웨이", "kbs:nvod1"),
            Ch("kbs", "태조 왕건", "kbs:nvod2"),
            Ch("kbs", "직장의 신", "kbs:nvod3"),
            Ch("kbs", "아이가 다섯", "kbs:nvod4"),
            Ch("kbs", "제빵왕 김탁구", "kbs:nvod5"),
            Ch("kbs", "내 딸 서영이", "kbs:nvod7"),
            Ch("kbs", "1박 2일", "kbs:nvod6"),
        )
    }
}
