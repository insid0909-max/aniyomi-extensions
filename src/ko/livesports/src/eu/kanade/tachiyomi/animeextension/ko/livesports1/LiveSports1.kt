package eu.kanade.tachiyomi.animeextension.ko.livesports1

import android.app.Application
import android.content.SharedPreferences
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import androidx.preference.SwitchPreferenceCompat
import eu.kanade.tachiyomi.animeextension.ko.livesports.DomainGuard
import eu.kanade.tachiyomi.animeextension.ko.livesports.ExtStatus
import eu.kanade.tachiyomi.animeextension.ko.livesports.LiveQuality
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 실시간스포츠1 = 굿라이브티비(gltv88.com) 스포츠중계 (2026-10-30 구조 확인)
 * 사이트의 "스포츠중계 A·B채널" 화면(/bbs/content.php?co_id=streamA) 안 iframe#player 가 중계 화면(gltv77.r2onframe.com/cli/mobile).
 * 중계 화면 글자 안에 경기 목록이 그대로 있음: window.r2onframe.data2 = '[{ssid, chcd, ctgr(종목), leag, name,
 * dttm(세계 표준시 UTC), oair(1=방송 중), surl·surl2·surl3(m3u8)}]' → 그대로 읽음 (암호 풀기 없음).
 * 목록·상세·회차는 모두 중계 화면 한 번 받기로 만들고, 카드 조건은 주소 # 뒤(서버로 안 감)에 실어 둠.
 */
class LiveSports1 : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "실시간스포츠1"
    override val lang = "ko"
    override val supportsLatest = true

    private val ua =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    // ================= 0. 주소와 설정값 =================
    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    private fun pref(key: String, default: Boolean): Boolean =
        runCatching { prefs()?.getBoolean(key, default) }.getOrNull() ?: default

    private fun autoOn() = pref(PREF_AUTO_DOMAIN, true)

    // 직접 넣은 주소 > (번호가 더 큰) 자동으로 찾은 주소 > 기본 주소
    override val baseUrl: String
        get() = DomainGuard.pick(prefs(), PREF_DOMAIN_KEY, DEFAULT_BASE_URL, autoOn(), { DOMAIN_REGEX.matches(it) })

    // 중계 화면 주소: 직접 넣은 주소 > 사이트 화면에서 찾은 주소 > 기본 주소
    private val frameUrl: String
        get() = DomainGuard.pick(prefs(), PREF_FRAME_KEY, DEFAULT_FRAME, false, { FRAME_REGEX.matches(it) }, newerDefault = false)

    override val client: OkHttpClient = network.cloudflareClient

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")
        .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
        .set("User-Agent", ua)

    private fun get(url: String, referer: String): Pair<Int, String>? = runCatching {
        val h = headers.newBuilder().set("Referer", referer).build()
        client.newCall(GET(url, h)).execute().use { it.code to it.body.string() }
    }.getOrNull()

    // ================= 0-1. 중계 화면 읽기 · 주소 찾기 =================
    /** 사이트의 중계 A·B 화면에서 중계 화면(iframe#player) 주소를 읽음 */
    private fun frameFromSite(base: String): String {
        for (co in listOf("streamA", "streamB", "stram")) {
            val (code, body) = get("$base/bbs/content.php?co_id=$co", "$base/") ?: continue
            if (code != 200) continue
            val tag = PLAYER_IFRAME.find(body)?.value ?: CLI_IFRAME.find(body)?.value ?: continue
            val src = SRC_ATTR.find(tag)?.groupValues?.get(1).orEmpty()
            if (FRAME_REGEX.matches(src)) return src
        }
        return ""
    }

    /** 중계 화면 글자 안의 경기 목록 (window.r2onframe.data2 = '[…]') */
    private fun readFrame(frame: String, base: String): JSONArray? {
        val (code, body) = get(frame, "$base/") ?: return null
        return if (code == 200) parseRaw(body) else null
    }

    @Volatile private var lastDiscover = 0L

    /** 중계 화면이 안 열리면: 사이트 화면에서 새 중계 화면 주소 → 사이트 주소 번호(gltvN.com)를 바꿔 가며 */
    private fun discover(): JSONArray? = synchronized(this) {
        if (System.currentTimeMillis() - lastDiscover < 60_000) return null
        lastDiscover = System.currentTimeMillis()
        fun tryBase(base: String): JSONArray? {
            val f = frameFromSite(base)
            if (f.isEmpty()) return null
            val list = readFrame(f, base) ?: return null
            if (base != baseUrl) DomainGuard.saveAuto(prefs(), PREF_DOMAIN_KEY, base)
            DomainGuard.saveAuto(prefs(), PREF_FRAME_KEY, f)
            return list
        }
        tryBase(baseUrl)?.let { return it }
        val m = NUM_HOST.find(baseUrl) ?: return null
        val n = m.groupValues[2].toInt()
        for (d in listOf(1, 2, 3, 4, 5, 6, 7, 8, -1, -2)) {
            if (n + d < 1) continue
            tryBase("https://${m.groupValues[1]}${n + d}.${m.groupValues[3]}")?.let { return it }
        }
        return null
    }

    // window.r2onframe.data2 = '…' 의 작은따옴표 글자를 한 글자씩 읽어 \\ · \' 를 풀고 JSON 으로
    // (정규식으로 긴 글자를 읽으면 안드로이드에서 스택 넘침이 날 수 있음)
    private fun parseRaw(body: String): JSONArray? {
        val m = DATA_START.find(body) ?: return null
        val sb = StringBuilder()
        var i = m.range.last + 1
        while (i < body.length) {
            val c = body[i]
            when {
                c == '\'' -> return runCatching { JSONArray(sb.toString()) }.getOrNull()
                c == '\\' && i + 1 < body.length -> {
                    val n = body[i + 1]
                    if (n != '\'' && n != '\\') sb.append('\\')
                    sb.append(n)
                    i++
                }
                else -> sb.append(c)
            }
            i++
        }
        return null
    }

    /** 받아 온 중계 화면에서 목록을 읽고, 없으면 주소 찾기 후 다시 */
    private fun rawFrom(response: Response): JSONArray {
        val body = if (response.isSuccessful) response.body.string() else ""
        parseRaw(body)?.let { return it }
        if (autoOn()) discover()?.let { return it }
        throw Exception("경기 목록을 받지 못했어요. 사이트 주소가 바뀌었으면 새 주소(예: gltv89.com)를 검색창에 붙여 넣어 주세요.")
    }

    // 넘겨 준 응답이면 # 이 빠질 수 있어 첫 요청의 주소에서 읽음
    private fun fragOf(response: Response): String =
        generateSequence(response) { it.priorResponse }.last().request.url.fragment.orEmpty()

    /** 중계 화면 요청. 카드 조건은 # 뒤에 (서버로 보내지 않음) */
    private fun frameRequest(fragment: String = ""): Request {
        val u = frameUrl + if (fragment.isEmpty()) "" else "#$fragment"
        return GET(u, headers)
    }

    // ================= 1. 경기 =================
    private class Game(
        val id: String,
        val label: String,
        val league: String,
        val title: String,
        val startKey: String,
        val start: Long,
        val urls: List<String>,
    )

    private fun str(o: JSONObject, key: String): String {
        val v = o.opt(key)
        return if (v == null || v == JSONObject.NULL) "" else v.toString().trim()
    }

    private fun sportLabel(o: JSONObject): String {
        val c = str(o, "ctgr").lowercase()
        if (c == "rugby") return if (NFL_REGEX.containsMatchIn(str(o, "leag"))) "미식축구" else "럭비"
        return CTGR_LABELS[c] ?: if (c.isEmpty()) "" else CAT_OTHER
    }

    private fun urlsOf(o: JSONObject): List<String> =
        listOf("surl", "surl2", "surl3").map { str(o, it) }.filter { it.startsWith("http") }.distinct()

    /** "2026-10-30 00:15:00" → ms. 중계 화면의 시각은 세계 표준시(UTC): KBO "09:30" = 한국 18:30 */
    private fun startMs(s: String): Long {
        val m = TIME_REGEX.find(s) ?: return 0L
        val (y, mo, d, h, mi) = m.destructured
        return Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(y.toInt(), mo.toInt() - 1, d.toInt(), h.toInt(), mi.toInt())
        }.timeInMillis
    }

    private fun kst(ms: Long, pattern: String): String =
        SimpleDateFormat(pattern, Locale.KOREA).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(Date(ms))

    private fun startShort(s: String): String = startMs(s).let { if (it == 0L) "" else kst(it, "MM.dd HH:mm") }

    private fun games(raw: JSONArray, src: String): List<Game> {
        val hide = pref(PREF_HIDE_ENDED, true)
        val now = System.currentTimeMillis()
        val out = ArrayList<Game>()
        for (i in 0 until raw.length()) {
            val o = raw.optJSONObject(i) ?: continue
            if (str(o, "actv") == "0") continue
            val urls = urlsOf(o)
            val live = str(o, "oair") == "1" && urls.isNotEmpty()
            if ((src == SRC_LIVE) != live) continue
            val label = sportLabel(o)
            val start = startMs(str(o, "dttm"))
            // 끝난 경기: 시작 후 종목별 시간이 지났는데 아직 방송 중(또는 예정)으로 남은 경기
            if (hide && start > 0 && now - start > (ENDED_HOURS[label] ?: 6) * 3_600_000L) continue
            out.add(
                Game(
                    id = str(o, "ssid").ifEmpty { str(o, "chcd") },
                    label = label,
                    league = str(o, "leag"),
                    title = str(o, "name").replace(SPACES_REGEX, " "),
                    startKey = str(o, "dttm"),
                    start = start,
                    urls = urls,
                ),
            )
        }
        return out
    }

    // ================= 2. 카드 =================
    private data class Params(val src: String, val cat: String, val sort: String, val q: String)

    private fun isAllCat(cat: String) = cat == ALL_CAT || cat == CHOICE_ALL

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun query(p: Params) = "src=${p.src}&cat=${enc(p.cat)}&sort=${p.sort}" + if (p.q.isEmpty()) "" else "&q=${enc(p.q)}"

    private fun paramsOf(text: String?): Params {
        val map = text.orEmpty().substringAfter('?').split('&').mapNotNull {
            val k = it.substringBefore('=', "")
            if (k.isEmpty()) null else k to runCatching { URLDecoder.decode(it.substringAfter('='), "UTF-8") }.getOrDefault("")
        }.toMap()
        return Params(
            src = if (map["src"] == SRC_SOON) SRC_SOON else SRC_LIVE,
            cat = map["cat"]?.ifEmpty { null } ?: ALL_CAT,
            sort = if (map["sort"] == SORT_TIME) SORT_TIME else SORT_CATEGORY,
            q = map["q"].orEmpty(),
        )
    }

    // 경기 수(n)·만든 시각(분, t)도 주소에 넣어 목록을 열 때마다 새 카드가 되게 함 → 카드를 누르면 앱이 항상 지금 경기 목록을 새로 받음
    // (앱은 처음 보는 카드만 회차를 새로 읽음. 서재에 담은 카드(주소 고정)는 카드 안에서 당겨서 새로고침)
    private fun cardUrl(p: Params, count: Int? = null): String =
        "/gltv?" + query(p) + if (count != null) "&n=$count&t=${System.currentTimeMillis() / 60_000}" else ""

    private fun cardTitle(p: Params): String {
        val prefix = if (p.src == SRC_SOON) "⏰ 예정 · " else ""
        val core = when {
            p.q.isNotEmpty() -> "🔎 \"${p.q}\""
            isAllCat(p.cat) -> "📡 전체 경기"
            p.cat == CAT_OTHER -> "🏅 기타 종목"
            else -> "${EMOJI[p.cat] ?: "🏅"} ${p.cat}"
        }
        return prefix + core
    }

    private fun thumbUrl(cat: String): String =
        "$THUMB_BASE/${if (isAllCat(cat)) "all" else THUMB_NAMES[cat] ?: "other"}.png"

    private fun matches(g: Game, p: Params): Boolean {
        val catOk = when {
            isAllCat(p.cat) -> true
            p.cat == CAT_OTHER -> g.label !in CATEGORY_ORDER
            else -> g.label == p.cat
        }
        val q = p.q.lowercase()
        return catOk && (q.isEmpty() || listOf(g.title, g.league, g.label).any { it.lowercase().contains(q) })
    }

    private fun makeCard(p: Params, games: List<Game>? = null): SAnime = SAnime.create().apply {
        val n = games?.count { matches(it, p) }
        title = cardTitle(p) + if (n != null) " · ${n}경기" else ""
        thumbnail_url = thumbUrl(p.cat)
        setUrlWithoutDomain(cardUrl(p, n))
    }

    // 지금 목록에 있는 종목만 카드로
    private fun cardsFor(games: List<Game>, src: String, sort: String): List<SAnime> {
        val present = games.map { it.label }.toSet()
        val cards = mutableListOf(makeCard(Params(src, ALL_CAT, sort, ""), games))
        CATEGORY_ORDER.filter { it in present }.forEach { cards.add(makeCard(Params(src, it, sort, ""), games)) }
        if (present.any { it.isNotEmpty() && it !in CATEGORY_ORDER }) cards.add(makeCard(Params(src, CAT_OTHER, sort, ""), games))
        return cards
    }

    override fun popularAnimeRequest(page: Int): Request = frameRequest()

    override fun popularAnimeParse(response: Response): AnimesPage =
        AnimesPage(cardsFor(games(rawFrom(response), SRC_LIVE), SRC_LIVE, SORT_CATEGORY), false)

    override fun latestUpdatesRequest(page: Int): Request = frameRequest()

    override fun latestUpdatesParse(response: Response): AnimesPage =
        AnimesPage(cardsFor(games(rawFrom(response), SRC_SOON), SRC_SOON, SORT_TIME), false)

    // ================= 3. 필터 / 검색 =================
    class SrcFilter : AnimeFilter.Select<String>("범위", arrayOf("방송 중", "예정"))
    class CategoryFilter : AnimeFilter.Select<String>("종목", CATEGORY_CHOICES)
    class SortFilter : AnimeFilter.Select<String>("정렬", arrayOf("종목순", "시간순"))

    override fun getFilterList(): AnimeFilterList = ExtStatus.prepend(
        "livesports1",
        baseUrl,
        autoOn(),
        AnimeFilterList(
            AnimeFilter.Header("검색창에 팀·대회 이름을 넣으면 그 경기만, 사이트 주소를 붙여 넣으면 그 주소로 바꿔요"),
            SrcFilter(),
            CategoryFilter(),
            SortFilter(),
        ),
    )

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val q = query.trim()
        // 사이트 주소(https:// 없어도)를 붙여 넣으면: 진짜 사이트면 그 주소로 바꾸고 방송 중 목록
        PASTE_REGEX.matchEntire(q)?.let { m ->
            val base = "https://${m.groupValues[1].lowercase()}"
            val f = frameFromSite(base)
            if (f.isEmpty() || readFrame(f, base) == null) throw Exception("${m.groupValues[1]} 에서 중계 화면을 찾지 못했어요. 주소를 다시 확인해 주세요.")
            // 처음 한 번 하는 칸 나누기(DomainGuard)가 먼저 끝나야 직접 넣은 칸 값이 지워지지 않음
            baseUrl.length
            prefs()?.edit()?.putString(PREF_DOMAIN_KEY, base)?.apply()
            DomainGuard.saveAuto(prefs(), PREF_FRAME_KEY, f)
            return frameRequest("paste")
        }
        var src = SRC_LIVE
        var choice = CHOICE_ALL
        var sort = SORT_CATEGORY
        filters.forEach { f ->
            when (f) {
                is SrcFilter -> src = if (f.state == 1) SRC_SOON else SRC_LIVE
                is CategoryFilter -> choice = CATEGORY_CHOICES[f.state]
                is SortFilter -> sort = if (f.state == 1) SORT_TIME else SORT_CATEGORY
                else -> {}
            }
        }
        return frameRequest("search?" + query(Params(src, choice, sort, q)))
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val frag = fragOf(response)
        val raw = rawFrom(response)
        if (frag == "paste") return AnimesPage(cardsFor(games(raw, SRC_LIVE), SRC_LIVE, SORT_CATEGORY), false)
        val p = paramsOf(frag)
        val list = games(raw, p.src)
        if (p.q.isEmpty() && p.cat == CHOICE_EACH) return AnimesPage(cardsFor(list, p.src, p.sort), false)
        val cat = if (p.cat == CHOICE_EACH || p.cat == CHOICE_ALL) ALL_CAT else p.cat
        return AnimesPage(listOf(makeCard(p.copy(cat = cat), list)), false)
    }

    // ================= 4. 상세 · 경기 목록 =================
    // 웹뷰 버튼: 사이트의 스포츠중계 화면
    override fun getAnimeUrl(anime: SAnime): String = "$baseUrl/bbs/content.php?co_id=streamA"

    override fun animeDetailsRequest(anime: SAnime): Request = frameRequest("card?" + anime.url.substringAfter('?'))

    override fun animeDetailsParse(response: Response): SAnime {
        val p = paramsOf(fragOf(response))
        val n = games(rawFrom(response), p.src).count { matches(it, p) }
        return SAnime.create().apply {
            title = cardTitle(p)
            thumbnail_url = thumbUrl(p.cat)
            status = SAnime.ONGOING
            description = "${if (p.src == SRC_SOON) "예정" else "방송 중"} ${n}경기 · 정렬: " +
                (if (p.sort == SORT_TIME) "시간순" else "종목순") + " · 굿라이브티비"
        }
    }

    override fun episodeListRequest(anime: SAnime): Request = animeDetailsRequest(anime)

    private fun categoryRank(label: String): Int = when {
        label.isEmpty() -> CATEGORY_ORDER.size + 1
        else -> CATEGORY_ORDER.indexOf(label).let { if (it >= 0) it else CATEGORY_ORDER.size }
    }

    private class Row(val name: String, val url: String, val scanlator: String?)

    override fun episodeListParse(response: Response): List<SEpisode> {
        val p = paramsOf(fragOf(response))
        val list = games(rawFrom(response), p.src).filter { matches(it, p) }
        val stamp = kst(System.currentTimeMillis(), "MM.dd HH:mm")
        val live = p.src != SRC_SOON
        if (list.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    name = "ℹ️ ${if (live) "현재 방송 중인 경기가 없습니다" else "예정된 경기가 없습니다"} ($stamp 기준)"
                    episode_number = 1f
                    url = "/play?kind=none"
                },
            )
        }
        val ordered = if (p.sort == SORT_TIME) {
            list.sortedBy { it.startKey.ifEmpty { "9999" } }
        } else {
            list.sortedWith(
                compareBy<Game>(
                    { categoryRank(it.label) },
                    { if (categoryRank(it.label) == CATEGORY_ORDER.size) it.label else "" },
                    { it.startKey.ifEmpty { "9999" } },
                ),
            )
        }
        val useEmoji = pref(PREF_EMOJI, true)
        val showStartLive = pref(PREF_START_TIME, true)
        val showHeaders = pref(PREF_HEADERS, true) && p.sort == SORT_CATEGORY && p.q.isEmpty() &&
            (isAllCat(p.cat) || p.cat == CAT_OTHER)
        val counts = ordered.groupingBy { it.label }.eachCount()

        // 맨 위는 목록을 받은 시각 (주소가 늘 같아 새 회차로 잡히지 않음)
        val rows = mutableListOf(Row("🕒 $stamp 기준 · 오래됐으면 아래로 당겨 새로고침", "/play?kind=header&n=time", null))
        var last: String? = null
        for (g in ordered) {
            val emoji = if (useEmoji) EMOJI[g.label] ?: if (g.label.isEmpty()) "" else "🏅" else ""
            if (showHeaders && g.label != last) {
                val head = listOf(emoji, g.label.ifEmpty { "기타" }, "(${counts[g.label]})").filter { it.isNotEmpty() }.joinToString(" ")
                rows.add(Row("━━ $head ━━", "/play?kind=header&n=${rows.size}", null))
            }
            last = g.label
            val start = if ((!live || showStartLive) && g.startKey.isNotEmpty()) "시작 ${startShort(g.startKey)}" else ""
            rows.add(
                Row(
                    name = when {
                        g.label.isEmpty() -> g.title
                        useEmoji -> "$emoji ${g.title}"
                        else -> "[${g.label}] ${g.title}"
                    },
                    url = "/play?id=${enc(g.id)}&src=${p.src}",
                    scanlator = listOf(start, g.label, g.league).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { null },
                ),
            )
        }
        // 앱이 "Missing N items"를 표시하지 않도록 위에서 아래로 번호를 연속으로 매김
        return rows.mapIndexed { index, r ->
            SEpisode.create().apply {
                name = r.name
                episode_number = (rows.size - index).toFloat()
                scanlator = r.scanlator
                url = r.url
            }
        }
    }

    // ================= 5. 재생 =================
    // 재생할 때 중계 화면을 다시 받아 그 경기의 최신 영상 주소를 씀
    override fun videoListRequest(episode: SEpisode): Request = frameRequest("play?" + episode.url.substringAfter('?'))

    override fun videoListParse(response: Response): List<Video> {
        val frag = fragOf(response).substringAfter('?')
        val args = paramsMap(frag)
        when (args["kind"]) {
            "header" -> throw Exception("구분 줄입니다. 아래의 경기를 선택하세요")
            "none" -> throw Exception("선택할 수 있는 경기가 없습니다")
        }
        val id = args["id"].orEmpty()
        if (id.isEmpty()) throw Exception("선택할 수 있는 경기가 없습니다")
        val raw = rawFrom(response)
        val o = (0 until raw.length()).mapNotNull { raw.optJSONObject(it) }
            .firstOrNull { str(it, "ssid").ifEmpty { str(it, "chcd") } == id }
            ?: throw Exception("경기 정보를 찾지 못했습니다. 방송이 끝났을 수 있으니 목록을 새로고침하세요")
        val urls = urlsOf(o)
        if (urls.isEmpty()) throw Exception("아직 방송 전이에요 (시작 ${startShort(str(o, "dttm")).ifEmpty { "미정" }})")

        val fo = frameUrl.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}" } ?: DEFAULT_FRAME_ORIGIN
        val base = baseUrl
        val variants = listOf(
            "중계 화면" to headersOf("$fo/", fo),
            "사이트" to headersOf("$base/", base),
            "UA만" to headersOf(null, null),
        )
        val out = mutableListOf<Video>()
        urls.forEachIndexed { i, m3u8 ->
            val suffix = if (i == 0) "" else " (대체 $i)"
            val log = mutableListOf<String>()
            var ok = false
            for ((label, h) in variants) {
                val r = runCatching {
                    client.newCall(GET(m3u8, h)).execute().use { it.code to it.body.string() }
                }.getOrNull()
                if (r != null && r.first == 200 && r.second.trimStart().startsWith("#EXTM3U")) {
                    val vs = LiveQuality.variants(client, m3u8, h)
                    out.add(Video(m3u8, if (vs.isEmpty()) "직접$suffix" else "자동 (최대 ${vs[0].first}p)$suffix", m3u8, h))
                    vs.forEach { (height, u) -> out.add(Video(u, "${height}p$suffix", u, h)) }
                    ok = true
                    break
                }
                log.add("$label:${r?.first ?: "오류"}")
            }
            // 확인이 안 돼도(영상 서버가 앱 통신을 막는 경우 등) 재생기에 맡겨 봄
            if (!ok) out.add(Video(m3u8, "확인 안 됨$suffix [${log.joinToString(" ")}]", m3u8, variants[0].second))
        }
        return LiveQuality.sort(prefs(), out)
    }

    private fun paramsMap(text: String): Map<String, String> = text.split('&').mapNotNull {
        val k = it.substringBefore('=', "")
        if (k.isEmpty()) null else k to runCatching { URLDecoder.decode(it.substringAfter('='), "UTF-8") }.getOrDefault("")
    }.toMap()

    private fun headersOf(ref: String?, origin: String?): Headers {
        val b = Headers.Builder().set("User-Agent", ua).set("Accept", "*/*")
        if (ref != null) b.set("Referer", ref)
        if (origin != null) b.set("Origin", origin)
        return b.build()
    }

    override fun videoUrlParse(response: Response): String = ""

    // ================= 6. 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context

        fun switchPref(prefKey: String, prefTitle: String, prefSummary: String, default: Boolean) =
            SwitchPreferenceCompat(ctx).apply {
                key = prefKey
                title = prefTitle
                summary = prefSummary
                setDefaultValue(default)
            }

        EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "사이트 주소 직접 지정 (선택)"
            summary = "비워 두면 기본 주소($DEFAULT_BASE_URL) 또는 자동으로 찾은 주소를 사용합니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 주소를 입력하세요 (예: https://gltv89.com)."
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                val ok = input.isEmpty() || DOMAIN_REGEX.matches(input)
                Toast.makeText(ctx, if (ok) "바꿨습니다. 목록을 새로고침하세요." else "올바른 주소 형식이 아닙니다 (예: https://gltv89.com)", Toast.LENGTH_SHORT).show()
                ok
            }
        }.also(screen::addPreference)

        EditTextPreference(ctx).apply {
            key = PREF_FRAME_KEY
            title = "중계 화면 주소 직접 지정 (선택)"
            summary = "비워 두면 사이트 화면에서 찾은 주소를 사용합니다.\n현재: $frameUrl"
            dialogTitle = "기본값: $DEFAULT_FRAME"
            setDefaultValue("")
            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim()
                val ok = input.isEmpty() || FRAME_REGEX.matches(input)
                if (!ok) Toast.makeText(ctx, "https:// 로 시작하는 주소를 입력하세요.", Toast.LENGTH_SHORT).show()
                ok
            }
        }.also(screen::addPreference)

        screen.addPreference(
            switchPref(
                PREF_AUTO_DOMAIN,
                "도메인 자동 찾기",
                "목록을 못 받으면 사이트 화면에서 새 중계 화면 주소를 찾고, 그래도 안 되면 주소 번호(gltvN.com)를 바꿔 찾습니다.",
                true,
            ),
        )
        screen.addPreference(
            switchPref(PREF_HEADERS, "종목 구분 줄 표시", "종목순 정렬에서 종목이 바뀔 때 ━━ ⚽ 축구 (5) ━━ 줄을 넣습니다.", true),
        )
        screen.addPreference(
            switchPref(PREF_EMOJI, "종목 이모지 표시", "경기 제목 앞에 종목 이모지를 붙입니다. 끄면 [축구] 형태로 표시합니다.", true),
        )
        screen.addPreference(
            switchPref(PREF_START_TIME, "시작 시각 표시", "방송 중인 경기에도 시작 시각(한국 시간)을 표시합니다. 예정 경기에는 항상 표시됩니다.", true),
        )
        screen.addPreference(
            switchPref(
                PREF_HIDE_ENDED,
                "끝난 경기 숨기기",
                "시작 후 종목별 시간(축구·농구·배구·하키 3, 야구·미식축구 5, 그 밖 6시간)이 지난 경기는 뺍니다.",
                true,
            ),
        )
        LiveQuality.addPreference(screen)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_FRAME_KEY = "pref_frame_key"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val PREF_HEADERS = "pref_section_headers"
        private const val PREF_EMOJI = "pref_emoji"
        private const val PREF_START_TIME = "pref_start_time"
        private const val PREF_HIDE_ENDED = "pref_hide_ended"

        private const val DEFAULT_BASE_URL = "https://gltv88.com"
        private const val DEFAULT_FRAME = "https://gltv77.r2onframe.com/cli/mobile"
        private const val DEFAULT_FRAME_ORIGIN = "https://gltv77.r2onframe.com"
        private const val THUMB_BASE = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs"

        private const val SRC_LIVE = "live"
        private const val SRC_SOON = "soon"
        private const val ALL_CAT = "전체 경기"
        private const val CAT_OTHER = "기타"
        private const val CHOICE_ALL = "전체"
        private const val CHOICE_EACH = "종목별 카드 모두"
        private const val SORT_CATEGORY = "category"
        private const val SORT_TIME = "time"

        private val CATEGORY_ORDER = listOf(
            "축구", "야구", "농구", "배구", "하키", "테니스", "미식축구", "e스포츠",
            "격투기", "골프", "배드민턴", "탁구", "핸드볼", "럭비", "크리켓",
        )
        private val CATEGORY_CHOICES: Array<String> = (listOf(CHOICE_ALL, CHOICE_EACH) + CATEGORY_ORDER + CAT_OTHER).toTypedArray()

        // 중계 화면의 종목 값(ctgr) → 이름 (rugby 는 NFL 이면 미식축구)
        private val CTGR_LABELS = mapOf(
            "football" to "축구", "soccer" to "축구", "basketball" to "농구", "baseball" to "야구", "hockey" to "하키",
            "tennis" to "테니스", "volleyball" to "배구", "egames" to "e스포츠", "esports" to "e스포츠", "fight" to "격투기",
            "handball" to "핸드볼", "golf" to "골프", "badminton" to "배드민턴", "tabletennis" to "탁구", "cricket" to "크리켓",
            "racing" to CAT_OTHER,
        )

        // 끝난 경기로 볼 시간 (시작 후, 그 밖 종목은 6시간)
        private val ENDED_HOURS = mapOf("축구" to 3, "농구" to 3, "배구" to 3, "하키" to 3, "야구" to 5, "미식축구" to 5)
        private val EMOJI = mapOf(
            "축구" to "⚽", "야구" to "⚾", "농구" to "🏀", "배구" to "🏐", "하키" to "🏒", "테니스" to "🎾",
            "미식축구" to "🏈", "e스포츠" to "🎮", "격투기" to "🥊", "골프" to "⛳", "배드민턴" to "🏸",
            "탁구" to "🏓", "핸드볼" to "🤾", "럭비" to "🏉", "크리켓" to "🏏",
        )
        private val THUMB_NAMES = mapOf(
            "축구" to "soccer", "야구" to "baseball", "농구" to "basketball", "배구" to "volleyball", "하키" to "hockey",
            "테니스" to "tennis", "미식축구" to "americanfootball", "e스포츠" to "esports", "격투기" to "fight",
            "골프" to "golf", "배드민턴" to "badminton", "탁구" to "tabletennis", "핸드볼" to "handball",
            "럭비" to "rugby", "크리켓" to "cricket",
        )

        private val DOMAIN_REGEX = Regex("""^https://(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$""")
        private val FRAME_REGEX = Regex("""^https://[A-Za-z0-9.-]+/\S*$""")
        private val NUM_HOST = Regex("""^https://(?:www\.)?([a-z]+)(\d+)\.([a-z]{2,6})$""")
        private val PASTE_REGEX = Regex("""^(?:https?://)?((?:www\.)?[A-Za-z]+\d*\.[A-Za-z]{2,6})/?$""")
        private val PLAYER_IFRAME = Regex("""<iframe[^>]*id=["']player["'][^>]*>""", RegexOption.IGNORE_CASE)
        private val CLI_IFRAME = Regex("""<iframe[^>]*src=["']https://[^"']*/cli/[^"']*["'][^>]*>""", RegexOption.IGNORE_CASE)
        private val SRC_ATTR = Regex("""src=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
        private val DATA_START = Regex("""r2onframe\.data2\s*=\s*'""")
        private val TIME_REGEX = Regex("""(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})""")
        private val NFL_REGEX = Regex("""NFL|미식""", RegexOption.IGNORE_CASE)
        private val SPACES_REGEX = Regex("""\s+""")
    }
}
