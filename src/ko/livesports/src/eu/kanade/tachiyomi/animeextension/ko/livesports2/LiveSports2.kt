package eu.kanade.tachiyomi.animeextension.ko.livesports2

import android.annotation.SuppressLint
import android.app.Application
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import androidx.preference.SwitchPreferenceCompat
import eu.kanade.tachiyomi.animeextension.ko.livesports.ExtStatus
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
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LiveSports2 : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "실시간스포츠2"
    override val lang = "ko"
    override val supportsLatest = true

    private val tag = "LiveSports2"
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
        prefs()?.getBoolean(key, default) ?: default

    override val baseUrl: String
        get() {
            val custom = prefs()?.getString(PREF_DOMAIN_KEY, "")
                ?.trim()?.trimEnd('/').orEmpty()
            return if (custom.isNotEmpty() && DOMAIN_REGEX.matches(custom)) custom else DEFAULT_BASE_URL
        }

    // www.tongtv.net -> tongtv.net
    private val siteHost: String
        get() = try {
            baseUrl.toHttpUrl().host.removePrefix("www.")
        } catch (e: Exception) {
            "tongtv.net"
        }

    // 경기 목록 API 주소: live.<사이트 도메인>
    private val apiBase: String
        get() = "https://live.$siteHost"

    // 사이트가 새 주소로 넘겨 주면 그 주소를 따라가 저장 (통티비 주소에는 번호가 없어 번호 찾기는 쓰지 않음)
    override val client: OkHttpClient = network.cloudflareClient.newBuilder()
        .addInterceptor { chain -> domainIntercept(chain) }
        .build()

    // ================= 0-1. 도메인 자동 찾기 =================
    private fun saveDomain(url: String) {
        prefs()?.edit()?.putString(PREF_DOMAIN_KEY, url)?.apply()
        Log.d(tag, "도메인 자동 변경: $url")
    }

    private fun isCloudflare(res: Response): Boolean =
        res.header("cf-mitigated") != null || res.header("Server")?.contains("cloudflare", true) == true

    private fun isDead(res: Response, reqHost: String): Boolean {
        val finalHost = res.request.url.host
        if (finalHost != reqHost && !finalHost.endsWith(siteHost)) return true
        if (res.code == 451 || res.code >= 500) return true
        return res.code == 403 && !isCloudflare(res)
    }

    // 새 사이트 주소 기준으로 요청 호스트를 바꾼다 (live.<사이트> / www.<사이트> / <사이트>)
    private fun moveHost(oldHost: String, oldSite: String, newSiteHost: String): String {
        val newSite = newSiteHost.removePrefix("www.")
        return when {
            oldHost == "live.$oldSite" -> "live.$newSite"
            oldHost == oldSite -> newSite
            else -> newSiteHost
        }
    }

    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val site = siteHost
        val reqHost = req.url.host
        val ours = pref(PREF_AUTO_DOMAIN, true) &&
            (reqHost == site || reqHost == "www.$site" || reqHost == "live.$site")
        if (!ours) return chain.proceed(req)

        fun retryOn(found: String): Response {
            saveDomain("https://$found")
            val host = moveHost(reqHost, site, found)
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(host).build()).build())
        }

        val res = try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            val found = followRedirect(site) ?: throw e
            return retryOn(found)
        }

        if (req.method == "GET" && isDead(res, reqHost)) {
            val found = followRedirect(site) ?: return res
            res.close()
            return retryOn(found)
        }

        // 사이트 페이지가 다른 주소로 넘어갔으면 그 주소를 저장
        val finalHost = res.request.url.host
        if (!reqHost.startsWith("live.") && finalHost != reqHost &&
            finalHost.removePrefix("www.") != site && apiAlive(finalHost)
        ) {
            saveDomain("https://$finalHost")
        }
        return res
    }

    private val discoverLock = Any()

    @Volatile private var lastDiscover = 0L

    private val plainClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .callTimeout(12, TimeUnit.SECONDS)
            .build()
    }

    // 새 주소의 경기 API(live.<사이트>/api/health)가 응답하면 실제 통티비로 본다
    private fun apiAlive(siteHostWithWww: String): Boolean = try {
        val r = Request.Builder()
            .url("https://live.${siteHostWithWww.removePrefix("www.")}/api/health")
            .header("User-Agent", ua)
            .build()
        plainClient.newCall(r).execute().use { it.isSuccessful }
    } catch (e: Exception) {
        false
    }

    // 사이트 첫 화면을 열어 다른 주소로 넘어가는지 확인
    private fun followRedirect(site: String): String? = synchronized(discoverLock) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now

        listOf("www.$site", site).firstNotNullOfOrNull { host ->
            try {
                val r = Request.Builder().url("https://$host/").header("User-Agent", ua).build()
                val fh = plainClient.newCall(r).execute().use { it.request.url.host }
                fh.takeIf { it.removePrefix("www.") != site && apiAlive(it) }
            } catch (e: Exception) {
                null
            }
        }
    }

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")
        .set("Origin", baseUrl)
        .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
        .set("User-Agent", ua)

    // ================= 1. API 주소와 카드 =================
    private data class Params(val src: String, val cat: String, val sort: String, val q: String)

    private fun isAllCat(cat: String) = cat == ALL_CAT || cat == CHOICE_ALL

    private fun collectionOf(src: String) = if (src == SRC_SOON) "view_bw_live_soon" else "view_bw_live_on"

    private fun listUrl(src: String): HttpUrl.Builder =
        "$apiBase/api/collections/${collectionOf(src)}/records".toHttpUrl().newBuilder()
            .addQueryParameter("page", "1")
            .addQueryParameter("perPage", "500")
            .addQueryParameter("skipTotal", "true")
            .addQueryParameter("filter", "sports != \"ETC\"")

    // 응답을 해석할 때 꺼내 쓰도록 종목/정렬/검색어를 요청 주소에 실어 둔다
    private fun listRequest(p: Params): Request {
        val url = listUrl(p.src)
            .addQueryParameter("ls_src", p.src)
            .addQueryParameter("ls_cat", p.cat)
            .addQueryParameter("ls_sort", p.sort)
            .addQueryParameter("ls_q", p.q)
            .build()
        return GET(url.toString(), headers)
    }

    private fun paramsOf(url: HttpUrl): Params = Params(
        src = if (url.queryParameter("ls_src") == SRC_SOON) SRC_SOON else SRC_LIVE,
        cat = url.queryParameter("ls_cat") ?: ALL_CAT,
        sort = if (url.queryParameter("ls_sort") == SORT_TIME) SORT_TIME else SORT_CATEGORY,
        q = url.queryParameter("ls_q").orEmpty(),
    )

    // 경기 수(n)도 주소에 넣는다: 애니요미는 한 번 본 카드의 제목을 저장해 두고 다시 쓰므로,
    // 경기 수가 바뀌면 다른 카드로 보이게 해야 새 제목(경기 수)이 화면에 나온다. n 은 읽을 때 무시
    private fun cardUrl(p: Params, count: Int? = null): String {
        val b = StringBuilder("/tong?src=${p.src}&cat=${URLEncoder.encode(p.cat, "UTF-8")}&sort=${p.sort}")
        if (p.q.isNotEmpty()) b.append("&q=").append(URLEncoder.encode(p.q, "UTF-8"))
        if (count != null) b.append("&n=").append(count)
        return b.toString()
    }

    private fun paramsFromCard(animeUrl: String): Params {
        val u = "https://local.invalid$animeUrl".toHttpUrlOrNull()
        return Params(
            src = if (u?.queryParameter("src") == SRC_SOON) SRC_SOON else SRC_LIVE,
            cat = u?.queryParameter("cat") ?: ALL_CAT,
            sort = if (u?.queryParameter("sort") == SORT_TIME) SORT_TIME else SORT_CATEGORY,
            q = u?.queryParameter("q").orEmpty(),
        )
    }

    private fun cardTitle(p: Params): String {
        val prefix = if (p.src == SRC_SOON) "⏰ 예정 · " else ""
        val core = when {
            p.q.isNotEmpty() -> "🔎 \"${p.q}\""
            isAllCat(p.cat) -> "📡 전체 경기"
            p.cat == CAT_OTHER -> "🏅 기타 종목"
            else -> "${categoryEmoji(p.cat)} ${p.cat}"
        }
        return prefix + core
    }

    // ---- 카드 표지 이미지 ----
    // 설정에 올바른 폴더 주소가 있으면 그것을, 아니면 기본 폴더를 사용
    private val thumbBase: String
        get() {
            val custom = prefs()?.getString(PREF_THUMB_BASE, "")
                ?.trim()?.trimEnd('/').orEmpty()
            return if (custom.isNotEmpty() && THUMB_BASE_REGEX.matches(custom)) custom else DEFAULT_THUMB_BASE
        }

    // 종목 이름 -> 이미지 파일 이름 (확장자 제외, 소문자 영어)
    private fun thumbName(cat: String): String = when {
        isAllCat(cat) -> "all"
        cat == CAT_OTHER -> "other"
        else -> when (cat) {
            "축구" -> "soccer"
            "야구" -> "baseball"
            "농구" -> "basketball"
            "배구" -> "volleyball"
            "하키" -> "hockey"
            "테니스" -> "tennis"
            "미식축구" -> "americanfootball"
            "e스포츠" -> "esports"
            "격투기" -> "fight"
            "골프" -> "golf"
            "배드민턴" -> "badminton"
            "탁구" -> "tabletennis"
            "핸드볼" -> "handball"
            "럭비" -> "rugby"
            "크리켓" -> "cricket"
            else -> "other"
        }
    }

    private fun thumbUrl(cat: String): String = "$thumbBase/${thumbName(cat)}.$THUMB_EXT"

    private fun makeCard(p: Params, count: Int? = null): SAnime = SAnime.create().apply {
        title = cardTitle(p) + if (count != null) " · ${count}경기" else ""
        thumbnail_url = thumbUrl(p.cat)
        setUrlWithoutDomain(cardUrl(p, count))
    }

    // 현재 목록에 있는 종목만 카드로 만들고, 제목 옆에 경기 수
    private fun cardsForTab(games: List<Game>, src: String, sort: String): List<SAnime> {
        val present = games.map { it.label }.toSet()
        fun card(cat: String) = Params(src, cat, sort, "").let { p -> makeCard(p, games.count { matches(it, p) }) }
        val cards = mutableListOf(card(ALL_CAT))
        CATEGORY_ORDER.filter { it in present }.forEach { cards.add(card(it)) }
        if (present.any { it.isNotEmpty() && it !in CATEGORY_ORDER }) {
            cards.add(card(CAT_OTHER))
        }
        return cards
    }

    // 인기 탭: 방송 중인 경기의 종목 카드
    override fun popularAnimeRequest(page: Int): Request =
        GET(listUrl(SRC_LIVE).build().toString(), headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val games = parseGames(response.body?.string().orEmpty(), SRC_LIVE)
        return AnimesPage(cardsForTab(games, SRC_LIVE, SORT_CATEGORY), false)
    }

    // 최신 탭: 곧 시작하는 경기의 종목 카드
    override fun latestUpdatesRequest(page: Int): Request =
        GET(listUrl(SRC_SOON).build().toString(), headers)

    override fun latestUpdatesParse(response: Response): AnimesPage {
        val games = parseGames(response.body?.string().orEmpty(), SRC_SOON)
        return AnimesPage(cardsForTab(games, SRC_SOON, SORT_CATEGORY), false)
    }

    // 필터/검색
    class SrcFilter(choices: Array<String>) : AnimeFilter.Select<String>("범위", choices)
    class CategoryFilter(choices: Array<String>) : AnimeFilter.Select<String>("종목", choices)
    class SortFilter(choices: Array<String>) : AnimeFilter.Select<String>("정렬", choices)

    override fun getFilterList(): AnimeFilterList = ExtStatus.prepend(
        "livesports2",
        baseUrl,
        pref(PREF_AUTO_DOMAIN, true),
        AnimeFilterList(
            AnimeFilter.Header("검색창에 팀명이나 대회명을 넣으면 해당 경기만 보입니다"),
            SrcFilter(SRC_CHOICES),
            CategoryFilter(CATEGORY_CHOICES),
            SortFilter(SORT_CHOICES),
        ),
    )

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
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
        return listRequest(Params(src, choice, sort, query.trim()))
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val p = paramsOf(response.request.url)
        val cat = if (p.cat == CHOICE_EACH || p.cat == CHOICE_ALL) ALL_CAT else p.cat
        return when {
            p.q.isNotEmpty() -> AnimesPage(listOf(makeCard(Params(p.src, cat, p.sort, p.q))), false)
            p.cat == CHOICE_EACH -> {
                val games = parseGames(response.body?.string().orEmpty(), p.src)
                AnimesPage(cardsForTab(games, p.src, p.sort), false)
            }
            else -> AnimesPage(listOf(makeCard(Params(p.src, cat, p.sort, ""))), false)
        }
    }

    override fun animeDetailsRequest(anime: SAnime): Request = listRequest(paramsFromCard(anime.url))

    override fun animeDetailsParse(response: Response): SAnime {
        val p = paramsOf(response.request.url)
        val games = parseGames(response.body?.string().orEmpty(), p.src)
        val n = games.count { matches(it, p) }
        return SAnime.create().apply {
            title = cardTitle(p)
            thumbnail_url = thumbUrl(p.cat)
            status = SAnime.ONGOING
            description = "${if (p.src == SRC_SOON) "예정" else "방송 중"} ${n}경기 · 정렬: " +
                if (p.sort == SORT_TIME) "시간순" else "종목순"
        }
    }

    override fun episodeListRequest(anime: SAnime): Request = listRequest(paramsFromCard(anime.url))

    // ================= 2. 경기 데이터 해석 =================
    private data class Game(
        val id: String,
        val src: String,
        val title: String,
        val home: String,
        val away: String,
        val league: String,
        val label: String,
        val qTime: String,
        val scoreHome: String,
        val scoreAway: String,
        val startKey: String,
        // 같은 경기가 여러 줄로 올라온 경우, 합쳐진 나머지 항목의 id
        val altIds: List<String> = emptyList(),
    )

    private fun str(o: JSONObject, key: String): String {
        val v = o.opt(key)
        return if (v == null || v == JSONObject.NULL) "" else v.toString().trim()
    }

    private fun sportLabel(raw: String): String {
        val k = raw.uppercase().replace(NON_ALNUM_REGEX, "")
        return when (k) {
            "" -> ""
            "SOCCER" -> "축구"
            "BASEBALL" -> "야구"
            "BASKETBALL" -> "농구"
            "VOLLEYBALL", "VOLLEY" -> "배구"
            "HOCKEY", "ICEHOCKEY" -> "하키"
            "TENNIS" -> "테니스"
            "FOOTBALL", "AMERICANFOOTBALL", "NFL" -> "미식축구"
            "EGAME", "LOL", "ESPORTS" -> "e스포츠"
            "BOXING", "MMA", "UFC" -> "격투기"
            "GOLF" -> "골프"
            "BADMINTON" -> "배드민턴"
            "TABLETENNIS" -> "탁구"
            "HANDBALL" -> "핸드볼"
            "RUGBY" -> "럭비"
            "CRICKET" -> "크리켓"
            else -> raw
        }
    }

    private fun categoryEmoji(label: String): String = when (label) {
        "" -> ""
        "축구" -> "⚽"
        "야구" -> "⚾"
        "농구" -> "🏀"
        "배구" -> "🏐"
        "하키" -> "🏒"
        "테니스" -> "🎾"
        "미식축구" -> "🏈"
        "e스포츠" -> "🎮"
        "격투기" -> "🥊"
        "골프" -> "⛳"
        "배드민턴" -> "🏸"
        "탁구" -> "🏓"
        "핸드볼" -> "🤾"
        "럭비" -> "🏉"
        "크리켓" -> "🏏"
        else -> "🏅"
    }

    private fun parseGames(json: String, src: String): List<Game> {
        val items = try {
            JSONObject(json).optJSONArray("items")
        } catch (e: Exception) {
            null
        } ?: return emptyList()

        val stripN = pref(PREF_STRIP_N, true)
        val merge = pref(PREF_MERGE, true)

        val out = ArrayList<Game>(items.length())
        for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            val id = str(o, "id")
            if (id.isEmpty()) continue

            // 설정에 따라 팀 이름 끝의 "(N)" 표기를 지운다
            val homeRaw = str(o, "team_name_home")
            val awayRaw = str(o, "team_name_away")
            val home = if (stripN) homeRaw.replace(N_MARK_REGEX, "").trim() else homeRaw
            val away = if (stripN) awayRaw.replace(N_MARK_REGEX, "").trim() else awayRaw
            val title = when {
                home.isNotEmpty() && away.isNotEmpty() -> "$home vs $away"
                else -> listOf(home, away).filter { it.isNotEmpty() }.joinToString(" ")
            }.ifEmpty { "경기 ${id.take(4)}" }

            out.add(
                Game(
                    id = id,
                    src = src,
                    title = title,
                    home = home,
                    away = away,
                    league = str(o, "league_name").replace(SPACES_REGEX, " "),
                    label = sportLabel(str(o, "sports")),
                    qTime = str(o, "q_time"),
                    scoreHome = str(o, "score_home"),
                    scoreAway = str(o, "score_away"),
                    startKey = str(o, "time_gmt9"),
                ),
            )
        }

        if (!merge) return out

        // 같은 경기(종목·팀·시작 시각이 같음)가 여러 줄로 올라온 경우 한 줄로 합친다
        val merged = LinkedHashMap<String, Game>()
        for (g in out) {
            val key = if (g.home.isEmpty() && g.away.isEmpty()) {
                "id:${g.id}"
            } else {
                "${g.label}|${g.home}|${g.away}|${g.startKey}"
            }
            val prev = merged[key]
            merged[key] = if (prev == null) g else prev.copy(altIds = prev.altIds + g.id)
        }
        return merged.values.toList()
    }

    private fun categoryRank(label: String): Int = when {
        label.isEmpty() -> CATEGORY_ORDER.size + 1
        else -> CATEGORY_ORDER.indexOf(label).let { if (it >= 0) it else CATEGORY_ORDER.size }
    }

    private fun matches(g: Game, p: Params): Boolean {
        val catOk = when {
            isAllCat(p.cat) -> true
            p.cat == CAT_OTHER -> g.label !in CATEGORY_ORDER
            else -> g.label == p.cat
        }
        val q = p.q.lowercase()
        val qOk = q.isEmpty() || listOf(g.home, g.away, g.league, g.label).any { it.lowercase().contains(q) }
        return catOk && qOk
    }

    // "2026-10-02 11:00:00.000Z" -> "10-02 11:00"
    private fun startShort(key: String): String = if (key.length >= 16) key.substring(5, 16) else key

    private class Row(val name: String, val url: String, val scanlator: String?)

    private fun infoEpisode(msg: String) = SEpisode.create().apply {
        name = "ℹ️ $msg"
        episode_number = 1f
        url = "/play?kind=none"
    }

    private fun buildEpisodes(games: List<Game>, p: Params): List<SEpisode> {
        val useEmoji = pref(PREF_EMOJI, true)
        val showScore = pref(PREF_SCORE, true)
        val headerSetting = pref(PREF_HEADERS, true)
        // 방송 중 목록의 시작 시각 표시 (예정 경기는 설정과 관계없이 항상 표시)
        val showStartLive = pref(PREF_START_TIME, false)

        val filtered = games.filter { matches(it, p) }
        if (filtered.isEmpty()) {
            return listOf(infoEpisode(if (p.src == SRC_SOON) "예정된 경기가 없습니다" else "현재 방송 중인 경기가 없습니다"))
        }

        // 시작 시각이 없는 항목은 맨 뒤로. 같은 값끼리는 목록 순서를 유지한다(안정 정렬)
        val ordered = if (p.sort == SORT_TIME) {
            filtered.sortedBy { it.startKey.ifEmpty { "9999" } }
        } else {
            filtered.sortedWith(
                compareBy<Game>(
                    { categoryRank(it.label) },
                    { if (categoryRank(it.label) == CATEGORY_ORDER.size) it.label else "" },
                    { it.startKey.ifEmpty { "9999" } },
                ),
            )
        }

        val counts = ordered.groupingBy { it.label }.eachCount()
        val showHeaders = headerSetting && p.sort == SORT_CATEGORY && p.q.isEmpty() &&
            (isAllCat(p.cat) || p.cat == CAT_OTHER)

        val rows = mutableListOf<Row>()
        var lastLabel: String? = null
        for (g in ordered) {
            val emoji = if (useEmoji) categoryEmoji(g.label) else ""

            // 종목이 바뀔 때 구분 줄 (같은 주소로 합쳐지지 않도록 줄 번호를 붙임)
            if (showHeaders && g.label != lastLabel) {
                val head = listOf(emoji, g.label.ifEmpty { "기타" }, "(${counts[g.label]})")
                    .filter { it.isNotEmpty() }
                    .joinToString(" ")
                rows.add(Row("━━ $head ━━", "/play?kind=header&n=${rows.size}", null))
            }
            lastLabel = g.label

            val info = if (g.src == SRC_SOON) {
                if (g.startKey.isEmpty()) "" else "시작 ${startShort(g.startKey)}"
            } else {
                val score = if (showScore && g.scoreHome.isNotEmpty() && g.scoreAway.isNotEmpty()) {
                    "${g.scoreHome}:${g.scoreAway}"
                } else {
                    ""
                }
                val start = if (showStartLive && g.startKey.isNotEmpty()) "시작 ${startShort(g.startKey)}" else ""
                listOf(g.qTime, score, start).filter { it.isNotEmpty() }.joinToString(" · ")
            }

            rows.add(
                Row(
                    name = when {
                        g.label.isEmpty() -> g.title
                        useEmoji -> "$emoji ${g.title}"
                        else -> "[${g.label}] ${g.title}"
                    },
                    url = "/play?id=${(listOf(g.id) + g.altIds).joinToString(",")}&src=${g.src}",
                    scanlator = listOf(info, g.label, g.league)
                        .filter { it.isNotEmpty() }
                        .joinToString(" · ")
                        .ifEmpty { null },
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

    override fun episodeListParse(response: Response): List<SEpisode> {
        val p = paramsOf(response.request.url)
        val games = parseGames(response.body?.string().orEmpty(), p.src)
        return buildEpisodes(games, p)
    }

    // ================= 3. 영상 요청 =================
    // 재생할 때 그 경기의 항목을 다시 조회해서 최신 플레이어 주소(web)를 받는다
    override fun videoListRequest(episode: SEpisode): Request {
        val u = "https://local.invalid${episode.url}".toHttpUrlOrNull()
        val src = if (u?.queryParameter("src") == SRC_SOON) SRC_SOON else SRC_LIVE
        val kind = u?.queryParameter("kind").orEmpty()

        // 같은 경기가 여러 줄로 올라온 경우 id가 쉼표로 이어져 있다 (최대 4개)
        val ids = u?.queryParameter("id").orEmpty()
            .split(",")
            .map { it.trim() }
            .filter { ID_REGEX.matches(it) }
            .distinct()
            .take(4)

        val ls = when {
            kind == "header" -> "header"
            ids.isEmpty() -> "none"
            else -> "play"
        }
        val filter = if (ids.isEmpty()) {
            "id = \"\""
        } else {
            ids.joinToString(" || ") { "id = \"$it\"" }
        }
        val url = "$apiBase/api/collections/${collectionOf(src)}/records".toHttpUrl().newBuilder()
            .addQueryParameter("page", "1")
            .addQueryParameter("perPage", "4")
            .addQueryParameter("skipTotal", "true")
            .addQueryParameter("filter", filter)
            .addQueryParameter("ls_kind", ls)
            .build()
        return GET(url.toString(), headers)
    }

    private fun shortUrl(u: String): String =
        u.toHttpUrlOrNull()?.let { "${it.host}${it.encodedPath}" } ?: u.take(40)

    // 플레이어(iframe)를 숨은 화면에서 실제 사이트처럼 열어 m3u8 요청을 가로챈다
    @SuppressLint("SetJavaScriptEnabled")
    private fun captureM3u8(web: String): String {
        val seen = Collections.synchronizedList(mutableListOf<String>())
        val m3u8s = Collections.synchronizedList(mutableListOf<String>())
        val latch = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        var webViewRef: WebView? = null

        val iframe = web
            .replace("{position}", "1")
            .replace("{width}", "100%")
            .replace("{height}", "100%")
            .replace("{sourceDomain}", siteHost)
            .replace("{poster}", siteHost)
        val html = "<!doctype html><html><head>" +
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "</head><body style=\"margin:0;background:#000;height:100vh\">$iframe</body></html>"

        handler.post {
            try {
                val context = Class.forName("android.app.ActivityThread")
                    .getMethod("currentApplication")
                    .invoke(null) as Application

                val webView = WebView(context)
                webViewRef = webView
                webView.settings.javaScriptEnabled = true
                webView.settings.domStorageEnabled = true
                webView.settings.mediaPlaybackRequiresUserGesture = false
                webView.settings.userAgentString = ua
                // 화면에 붙지 않은 WebView는 크기가 0이라 플레이어가 멈출 수 있어 크기를 준다
                try {
                    webView.layout(0, 0, 1080, 1920)
                } catch (e: Exception) {
                    // 무시
                }

                webView.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? {
                        val url = request.url.toString()
                        if (seen.size < 60) seen.add("${request.url.host}${request.url.path}".take(70))
                        if (url.contains(".m3u8")) {
                            m3u8s.add(url)
                            latch.countDown()
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }

                // 실제 사이트의 iframe과 같은 조건(부모 페이지 주소)으로 연다
                webView.loadDataWithBaseURL("$baseUrl/broadcast", html, "text/html", "UTF-8", null)
            } catch (e: Exception) {
                Log.d(tag, "webview error: ${e.message}")
                latch.countDown()
            }
        }

        latch.await(20, TimeUnit.SECONDS)

        // 재생목록(playlist.m3u8)이 곧 이어서 올 수 있어 잠깐 더 기다린다
        if (m3u8s.isNotEmpty()) {
            var waited = 0
            while (waited < 2000 && m3u8s.none { it.contains("playlist.m3u8") }) {
                Thread.sleep(250)
                waited += 250
            }
        }

        handler.post {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }

        val pick = m3u8s.firstOrNull { it.contains("playlist.m3u8") } ?: m3u8s.firstOrNull()
        if (pick == null) {
            throw Exception(
                "영상 주소를 찾지 못함 | 요청 ${seen.size}개 | " + seen.distinct().take(6).joinToString(", "),
            )
        }
        return pick
    }

    override fun videoListParse(response: Response): List<Video> {
        when (response.request.url.queryParameter("ls_kind")) {
            "header" -> throw Exception("구분 줄입니다. 아래의 경기를 선택하세요")
            "none" -> throw Exception("선택할 수 있는 경기가 없습니다")
        }

        val arr = try {
            JSONObject(response.body?.string().orEmpty()).optJSONArray("items")
        } catch (e: Exception) {
            null
        }
        if (arr == null || arr.length() == 0) {
            throw Exception("경기 정보를 찾지 못했습니다. 방송이 끝났을 수 있으니 목록을 새로고침하세요")
        }

        // 같은 경기의 중계가 여럿이면 앞에서부터 시도해서 되는 것을 사용한다
        val errors = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val rec = arr.optJSONObject(i) ?: continue
            val web = str(rec, "web")
            if (web.isEmpty()) {
                errors.add("#${i + 1} 영상 없음")
                continue
            }
            try {
                return resolveVideos(web, if (i == 0) "" else " (대체 ${i + 1})")
            } catch (e: Exception) {
                errors.add("#${i + 1} ${e.message}")
            }
        }
        throw Exception(
            if (errors.isEmpty()) "이 경기는 아직 영상이 준비되지 않았습니다" else errors.joinToString(" || "),
        )
    }

    private fun resolveVideos(web: String, suffix: String): List<Video> {
        val m3u8 = captureM3u8(web)

        // 앱(OkHttp)으로 접근 가능한 헤더 조합을 찾는다
        val log = mutableListOf<String>()
        var best: Candidate? = null
        for ((label, h) in headerVariants()) {
            val r = probe(m3u8, h)
            log.add("$label:${r.take(14)}")
            if (r.startsWith("m3u8=200")) {
                val c = Candidate(label, h, r)
                if (best == null || (r.contains("sub=200") && !best.result.contains("sub=200"))) best = c
                if (r.contains("sub=200")) break
            }
        }
        val chosen = best ?: throw Exception("재생 실패 [${shortUrl(m3u8)}] " + log.joinToString(" | "))

        // 로컬 프록시: 플레이어는 127.0.0.1로 요청하고 실제 요청은 앱이 대신 보낸다
        val port = ensureProxy()
        proxyHeaders = chosen.headers
        try {
            allowedHosts.add(m3u8.toHttpUrl().host)
        } catch (e: Exception) {
            // 무시
        }
        val proxied = proxyUrl(port, m3u8)

        return listOf(
            Video(proxied, "프록시 [${chosen.label}]$suffix", proxied, Headers.Builder().build()),
            Video(m3u8, "직접 [${chosen.label} ${chosen.result}]$suffix", m3u8, chosen.headers),
        )
    }

    override fun videoUrlParse(response: Response): String = ""

    // ================= 4. 헤더 조합 시험 =================
    private class Candidate(val label: String, val headers: Headers, val result: String)

    private fun headerVariants(): List<Pair<String, Headers>> {
        fun build(ref: String?, origin: String?): Headers {
            val b = Headers.Builder().set("User-Agent", ua).set("Accept", "*/*")
            if (ref != null) b.set("Referer", ref)
            if (origin != null) b.set("Origin", origin)
            return b.build()
        }
        return listOf(
            "liventv" to build("https://liventv.com/", "https://liventv.com"),
            "tongtv" to build("$baseUrl/", baseUrl),
            "UA만" to build(null, null),
        )
    }

    // m3u8과 그 안의 첫 하위 주소(조각/변형 목록)까지 요청해 결과를 문자열로 돌려준다
    private fun probe(url: String, h: Headers): String {
        return try {
            val res = client.newCall(GET(url, h)).execute()
            val code = res.code
            val body = res.use { it.body?.string() ?: "" }
            if (code != 200 || !body.startsWith("#EXTM3U")) return "m3u8=$code"

            val next = body.lineSequence().map { it.trim() }
                .firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
                ?: return "m3u8=200"
            val subUrl = try {
                java.net.URI(url).resolve(next).toString()
            } catch (e: Exception) {
                next
            }
            val subCode = client.newCall(GET(subUrl, h)).execute().use { it.code }
            "m3u8=200 sub=$subCode"
        } catch (e: Exception) {
            "예외 ${e.message?.take(30)}"
        }
    }

    // ================= 5. 로컬 프록시 =================
    @Volatile private var proxyServer: ServerSocket? = null

    @Volatile private var proxyHeaders: Headers = Headers.Builder().build()
    private val proxyPool = Executors.newCachedThreadPool()

    // 재생목록에서 확인된 호스트만 프록시가 대신 요청하도록 허용
    private val allowedHosts: MutableSet<String> = ConcurrentHashMap.newKeySet()

    private fun ensureProxy(): Int {
        proxyServer?.let { if (!it.isClosed) return it.localPort }
        synchronized(this) {
            proxyServer?.let { if (!it.isClosed) return it.localPort }
            val ss = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
            proxyServer = ss
            Thread {
                while (!ss.isClosed) {
                    try {
                        val s = ss.accept()
                        proxyPool.execute { handleProxy(s) }
                    } catch (e: Exception) {
                        break
                    }
                }
            }.apply { isDaemon = true }.start()
            return ss.localPort
        }
    }

    private fun proxyUrl(port: Int, target: String): String =
        "http://127.0.0.1:$port/p?u=" + URLEncoder.encode(target, "UTF-8")

    // 재생목록 안의 주소(조각, 하위 목록, 키)를 모두 프록시 주소로 바꾼다
    private fun rewritePlaylist(base: String, body: String, port: Int): String {
        fun wrap(u: String): String {
            val abs = try {
                java.net.URI(base).resolve(u).toString()
            } catch (e: Exception) {
                u
            }
            try {
                allowedHosts.add(abs.toHttpUrl().host)
            } catch (e: Exception) {
                // 잘못된 주소는 무시
            }
            return proxyUrl(port, abs)
        }
        return body.lineSequence().joinToString("\n") { line ->
            val t = line.trim()
            when {
                t.isEmpty() -> line
                t.startsWith("#") ->
                    Regex("URI=\"([^\"]+)\"").replace(line) { m -> "URI=\"" + wrap(m.groupValues[1]) + "\"" }
                else -> wrap(t)
            }
        }
    }

    private fun handleProxy(s: Socket) {
        try {
            s.soTimeout = 30000
            val reader = BufferedReader(InputStreamReader(s.getInputStream()))
            val requestLine = reader.readLine() ?: return
            while (true) {
                val l = reader.readLine() ?: break
                if (l.isEmpty()) break
            }
            val enc = requestLine.substringAfter("u=", "").substringBefore(" ")
            val target = URLDecoder.decode(enc, "UTF-8")
            val out = s.getOutputStream()

            val targetHost = try {
                target.toHttpUrl().host
            } catch (e: Exception) {
                ""
            }
            if (targetHost !in allowedHosts) {
                out.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n".toByteArray())
                out.flush()
                return
            }

            val req = Request.Builder().url(target).headers(proxyHeaders).build()
            client.newCall(req).execute().use { res ->
                val ct = res.header("Content-Type") ?: ""
                val isPlaylist = target.substringBefore("?").endsWith(".m3u8") ||
                    ct.contains("mpegurl", true)

                if (isPlaylist && res.isSuccessful) {
                    val text = res.body?.string() ?: ""
                    val bytes = rewritePlaylist(target, text, s.localPort).toByteArray(Charsets.UTF_8)
                    out.write(
                        (
                            "HTTP/1.1 200 OK\r\n" +
                                "Content-Type: application/vnd.apple.mpegurl\r\n" +
                                "Content-Length: ${bytes.size}\r\n" +
                                "Connection: close\r\n\r\n"
                            ).toByteArray(),
                    )
                    out.write(bytes)
                } else {
                    val status = if (res.isSuccessful) "200 OK" else "${res.code} Error"
                    val type = ct.ifEmpty { "application/octet-stream" }
                    out.write(
                        ("HTTP/1.1 $status\r\nContent-Type: $type\r\nConnection: close\r\n\r\n").toByteArray(),
                    )
                    res.body?.byteStream()?.copyTo(out)
                }
                out.flush()
            }
        } catch (e: Exception) {
            Log.d(tag, "proxy error: ${e.message}")
        } finally {
            try {
                s.close()
            } catch (e: Exception) {
                // 무시
            }
        }
    }

    // ================= 6. 설정 화면 =================
    // 이 빌드 환경에는 PreferenceCategory가 없어서, 항목 이름 앞의 [공통] / [전용] 표시로 구분한다
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val ctx = screen.context

        fun summaryOf(current: String) =
            "빈 값이면 기본 주소($DEFAULT_BASE_URL)를 사용합니다.\n현재 주소: $current"

        fun thumbSummary(current: String) =
            "빈 값이면 기본 폴더를 사용합니다.\n현재 폴더: $current"

        fun switchPref(prefKey: String, prefTitle: String, prefSummary: String, default: Boolean) =
            SwitchPreferenceCompat(ctx).apply {
                key = prefKey
                title = prefTitle
                summary = prefSummary
                setDefaultValue(default)
            }

        // ---- [공통] 두 확장 동일 ----
        val domainPref = EditTextPreference(ctx).apply {
            key = PREF_DOMAIN_KEY
            title = "[공통] 사이트 주소 직접 지정 (선택)"
            summary = summaryOf(baseUrl)
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https:// 로 시작하는 주소를 입력하세요. 목록 API는 live.<도메인>으로 자동 계산됩니다."
            setDefaultValue("")

            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                when {
                    input.isEmpty() -> {
                        summary = summaryOf(DEFAULT_BASE_URL)
                        Toast.makeText(ctx, "기본 주소로 되돌렸습니다.", Toast.LENGTH_SHORT).show()
                        true
                    }
                    DOMAIN_REGEX.matches(input) -> {
                        summary = summaryOf(input)
                        Toast.makeText(ctx, "주소가 변경되었습니다: $input", Toast.LENGTH_SHORT).show()
                        true
                    }
                    else -> {
                        Toast.makeText(
                            ctx,
                            "올바른 주소 형식이 아닙니다 (예: https://www.tongtv.net)",
                            Toast.LENGTH_LONG,
                        ).show()
                        false
                    }
                }
            }
        }
        screen.addPreference(domainPref)

        screen.addPreference(
            switchPref(
                PREF_AUTO_DOMAIN,
                "[공통] 도메인 자동 찾기",
                "접속이 안 되거나 막히면 사이트가 넘겨 주는 새 주소로 자동 변경합니다. " +
                    "(통티비 주소에는 번호가 없어 번호를 바꿔 찾지는 않습니다)",
                true,
            ),
        )

        val thumbPref = EditTextPreference(ctx).apply {
            key = PREF_THUMB_BASE
            title = "[공통] 표지 이미지 폴더 주소 (선택)"
            summary = thumbSummary(thumbBase)
            dialogTitle = "기본 폴더"
            dialogMessage = "종목별 이미지(soccer.png 등)가 들어 있는 폴더 주소입니다. " +
                "https:// 로 시작하고 끝에 / 를 붙이지 않습니다.\n기본값: $DEFAULT_THUMB_BASE"
            setDefaultValue("")

            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                when {
                    input.isEmpty() -> {
                        summary = thumbSummary(DEFAULT_THUMB_BASE)
                        Toast.makeText(ctx, "기본 폴더로 되돌렸습니다.", Toast.LENGTH_SHORT).show()
                        true
                    }
                    THUMB_BASE_REGEX.matches(input) -> {
                        summary = thumbSummary(input)
                        Toast.makeText(ctx, "폴더 주소가 변경되었습니다.", Toast.LENGTH_SHORT).show()
                        true
                    }
                    else -> {
                        Toast.makeText(ctx, "https:// 로 시작하는 주소를 입력하세요.", Toast.LENGTH_LONG).show()
                        false
                    }
                }
            }
        }
        screen.addPreference(thumbPref)

        screen.addPreference(
            switchPref(
                PREF_HEADERS,
                "[공통] 종목 구분 줄 표시",
                "종목순 정렬에서 종목이 바뀔 때 ━━ ⚽ 축구 (5) ━━ 줄을 넣습니다. 바꾼 뒤 목록을 새로고침하세요.",
                true,
            ),
        )
        screen.addPreference(
            switchPref(
                PREF_EMOJI,
                "[공통] 종목 이모지 표시",
                "경기 제목 앞에 종목 이모지를 붙입니다. 끄면 [축구] 형태로 표시합니다.",
                true,
            ),
        )
        screen.addPreference(
            switchPref(
                PREF_START_TIME,
                "[공통] 시작 시각 표시",
                "방송 중인 경기의 날짜 옆 줄에도 시작 시각을 표시합니다. 예정 경기에는 항상 표시됩니다. 바꾼 뒤 목록을 새로고침하세요.",
                false,
            ),
        )

        // ---- [전용] 이 확장만 ----
        screen.addPreference(
            switchPref(
                PREF_SCORE,
                "[전용] 점수·진행 상황 표시",
                "방송 중인 경기의 날짜 옆 줄에 진행 상황과 점수를 표시합니다.",
                true,
            ),
        )
        screen.addPreference(
            switchPref(
                PREF_MERGE,
                "[전용] 같은 경기 합치기",
                "종목·팀·시작 시각이 같은 항목이 여러 줄로 올라오면 한 줄로 합칩니다. 재생할 때 되는 중계를 자동으로 고릅니다. 바꾼 뒤 목록을 새로고침하세요.",
                true,
            ),
        )
        screen.addPreference(
            switchPref(
                PREF_STRIP_N,
                "[전용] 팀 이름의 (N) 지우기",
                "팀 이름 끝에 붙은 (N) 표기를 지웁니다. 바꾼 뒤 목록을 새로고침하세요.",
                true,
            ),
        )
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_THUMB_BASE = "pref_thumb_base"
        private const val PREF_HEADERS = "pref_section_headers"
        private const val PREF_EMOJI = "pref_emoji"
        private const val PREF_START_TIME = "pref_start_time"
        private const val PREF_SCORE = "pref_score"
        private const val PREF_MERGE = "pref_merge_dup"
        private const val PREF_STRIP_N = "pref_strip_n"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"

        private const val DEFAULT_BASE_URL = "https://www.tongtv.net"

        // 카드 표지 이미지: <폴더>/<이름>.<확장자> (확장자를 바꾸려면 THUMB_EXT만 고치면 됨)
        private const val DEFAULT_THUMB_BASE =
            "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs"
        private const val THUMB_EXT = "png"

        private const val SRC_LIVE = "live"
        private const val SRC_SOON = "soon"
        private const val ALL_CAT = "전체 경기"
        private const val CAT_OTHER = "기타"
        private const val CHOICE_ALL = "전체"
        private const val CHOICE_EACH = "종목별 카드 모두"
        private const val SORT_CATEGORY = "category"
        private const val SORT_TIME = "time"

        // 목록에 보이는 종목 순서 (바꾸고 싶으면 이 목록의 순서를 고치세요)
        private val CATEGORY_ORDER = listOf(
            "축구", "야구", "농구", "배구", "하키", "테니스", "미식축구", "e스포츠",
            "격투기", "골프", "배드민턴", "탁구", "핸드볼", "럭비", "크리켓",
        )

        private val SRC_CHOICES: Array<String> = arrayOf("방송 중", "예정")
        private val SORT_CHOICES: Array<String> = arrayOf("종목순", "시간순")
        private val CATEGORY_CHOICES: Array<String> =
            (listOf(CHOICE_ALL, CHOICE_EACH) + CATEGORY_ORDER + CAT_OTHER).toTypedArray()

        private val DOMAIN_REGEX = Regex("""^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$""")
        private val THUMB_BASE_REGEX = Regex("""^https://\S+$""")
        private val ID_REGEX = Regex("""^[A-Za-z0-9]{6,40}$""")
        private val NON_ALNUM_REGEX = Regex("""[^A-Za-z0-9]""")
        private val SPACES_REGEX = Regex("""\s+""")
        private val N_MARK_REGEX = Regex("""\s*\(N\)""")
    }
}
