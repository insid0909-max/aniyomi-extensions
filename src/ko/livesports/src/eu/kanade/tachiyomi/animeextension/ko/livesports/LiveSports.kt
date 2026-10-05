package eu.kanade.tachiyomi.animeextension.ko.livesports

import android.annotation.SuppressLint
import android.app.Application
import android.content.SharedPreferences
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import androidx.preference.SwitchPreferenceCompat
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
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LiveSports : AnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "실시간스포츠"
    override val lang = "ko"
    override val supportsLatest = true

    private val tag = "LiveSports"

    // ================= 0. 사이트 주소와 설정값 =================
    private fun prefs(): SharedPreferences? = runCatching {
        val app = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
        app?.getSharedPreferences("source_$id", 0)
    }.getOrNull()

    private fun pref(key: String, default: Boolean): Boolean =
        prefs()?.getBoolean(key, default) ?: default

    // 설정에 올바른 주소가 있으면 그것을, 아니면 기본 주소를 사용
    override val baseUrl: String
        get() {
            val custom = prefs()?.getString(PREF_DOMAIN_KEY, "")
                ?.trim()?.trimEnd('/').orEmpty()
            return if (custom.isNotEmpty() && DOMAIN_REGEX.matches(custom)) custom else DEFAULT_BASE_URL
        }

    private val livePageUrl: String
        get() = "$baseUrl/bbs/page.php?hid=livetv_a"

    // 영상 주소의 ?site= 값 (현재 사이트 도메인에 맞춤)
    private val siteHost: String
        get() = try {
            baseUrl.toHttpUrl().host
        } catch (e: Exception) {
            "njtv-01.com"
        }

    // 페이지 로드 중 가로챈 값들 (호스트는 수시로 바뀌므로 매번 새로 읽음)
    @Volatile private var capturedJson: String? = null

    @Volatile private var capturedM3u8: String? = null

    @Volatile private var iframeHost: String? = null

    @Volatile private var liveHost: String? = null

    @Volatile private var candidateHeads = ""

    @Volatile private var firstItemDebug = ""

    @Volatile private var lastCaptureTime = 0L

    // 마지막으로 정상 가져온 경기 항목 (가져오기에 실패해도 이걸로 목록을 만든다)
    @Volatile private var lastGoodItems: List<ParsedItem> = emptyList()

    @Volatile private var lastGoodTime = 0L

    // 목록 추출에 필요 없는 리소스 (이미지/폰트)는 차단해서 로딩을 줄임
    private val blockedAssets = Regex(""".*\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$""", RegexOption.IGNORE_CASE)

    // 주소 번호가 바뀌어 접속이 안 되면 njtv-01~60.com 중 열리는 주소를 찾아 자동 연결
    override val client: OkHttpClient = network.cloudflareClient.newBuilder()
        .addInterceptor { chain -> domainIntercept(chain) }
        .build()

    // ================= 0-1. 도메인 자동 찾기 =================
    private fun saveDomain(url: String) {
        prefs()?.edit()?.putString(PREF_DOMAIN_KEY, url)?.apply()
        lastCaptureTime = 0L
        Log.d(tag, "도메인 자동 변경: $url")
    }

    // 접속 실패, 차단(451/5xx), 차단 안내 페이지로 넘어간 경우를 막힌 주소로 본다
    private fun isDead(res: Response, reqHost: String): Boolean {
        val finalHost = res.request.url.host
        if (finalHost != reqHost && !HOST_REGEX.matches(finalHost)) return true
        if (res.code == 451 || res.code >= 500) return true
        // Cloudflare 확인 화면(403)은 살아 있는 주소
        return res.code == 403 && !isCloudflare(res)
    }

    private fun isCloudflare(res: Response): Boolean =
        res.header("cf-mitigated") != null || res.header("Server")?.contains("cloudflare", true) == true

    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val baseHost = baseUrl.toHttpUrlOrNull()?.host
        if (baseHost == null || req.url.host != baseHost || !HOST_REGEX.matches(baseHost) ||
            !pref(PREF_AUTO_DOMAIN, true)
        ) {
            return chain.proceed(req)
        }

        fun retryOn(found: String): Response {
            saveDomain("https://$found")
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(found).build()).build())
        }

        val res = try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            val found = discoverDomain(baseHost) ?: throw e
            return retryOn(found)
        }

        if (req.method == "GET" && isDead(res, baseHost)) {
            val found = discoverDomain(baseHost) ?: return res
            res.close()
            return retryOn(found)
        }

        // 사이트가 스스로 새 주소로 넘겨 준 경우 그 주소를 저장
        val finalHost = res.request.url.host
        if (finalHost != baseHost && HOST_REGEX.matches(finalHost)) saveDomain("https://$finalHost")
        return res
    }

    private val discoverLock = Any()

    @Volatile private var lastDiscover = 0L

    private fun hostNumber(host: String): Int =
        HOST_REGEX.find(host)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    // njtv-01~60.com 을 동시에 열어 보고 실제 사이트인 주소를 고른다
    // (내용까지 확인된 주소 우선, 없으면 Cloudflare 확인 화면이 뜨는 주소, 같으면 큰 번호 우선)
    private fun discoverDomain(currentHost: String): String? = synchronized(discoverLock) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now

        val plain = OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
        val ua = headersBuilder().build()["User-Agent"].orEmpty()
        val pool = Executors.newFixedThreadPool(20)
        try {
            val futures = (1..60).map { String.format(Locale.ROOT, "njtv-%02d.com", it) }
                .map { host ->
                    pool.submit<Pair<String, Int>?> {
                        try {
                            val r = Request.Builder().url("https://$host/").header("User-Agent", ua).build()
                            plain.newCall(r).execute().use { res ->
                                val fh = res.request.url.host
                                if (!HOST_REGEX.matches(fh)) return@use null
                                val body = res.peekBody(200_000).string()
                                when {
                                    res.code == 200 && SITE_MARKER.containsMatchIn(body) -> fh to 2
                                    res.code == 403 && isCloudflare(res) -> fh to 1
                                    else -> null
                                }
                            }
                        } catch (e: Exception) {
                            null
                        }
                    }
                }
            futures.mapNotNull { it.get() }
                .maxWithOrNull(compareBy<Pair<String, Int>> { it.second }.thenBy { hostNumber(it.first) })
                ?.first
                ?.takeIf { it != currentHost } // 지금 주소가 가장 좋은 주소면 바꾸지 않음
        } finally {
            pool.shutdown()
        }
    }

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .set("Referer", "$baseUrl/")
        .set("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
        .set(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        )

    // ================= 1. 카드와 필터 =================
    private fun isAllCat(cat: String) = cat == ALL_CAT || cat == CHOICE_ALL

    // 실시간스포츠2 와 같은 모양: "📡 전체 경기", "⚽ 축구" (+ 목록 카드에는 " · 5경기")
    private fun cardTitle(cat: String): String = when {
        isAllCat(cat) -> "📡 전체 경기"
        cat == CAT_OTHER -> "🏅 기타 종목"
        cat == LABEL_TV -> "📺 TV 채널"
        else -> "${categoryEmoji(cat)} $cat"
    }

    /** 종목 카드에 들어가는 경기인지 (전체 보기에서 TV 숨김 설정 반영) */
    private fun inCat(p: ParsedItem, cat: String, hideTv: Boolean): Boolean = when {
        isAllCat(cat) -> !(hideTv && p.label == LABEL_TV)
        cat == CAT_OTHER -> p.label != LABEL_TV && p.label !in CATEGORY_ORDER
        else -> p.label == cat
    }

    /** 목록 카드용 현재 경기 목록 (가져오기 실패 시 30분 안의 직전 목록, 그것도 없으면 빈 목록) */
    private fun currentItems(): List<ParsedItem> {
        val items = runCatching {
            ensureCaptured()
            capturedJson?.let { parseItems(it) }.orEmpty()
        }.getOrDefault(emptyList())
        if (items.isNotEmpty()) {
            lastGoodItems = items
            lastGoodTime = System.currentTimeMillis()
            return items
        }
        return lastGoodItems.takeIf { System.currentTimeMillis() - lastGoodTime < LAST_GOOD_MAX_AGE_MS }.orEmpty()
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
            "롤" -> "esports"
            "복싱" -> "fight"
            LABEL_TV -> "tv"
            else -> "other"
        }
    }

    private fun thumbUrl(cat: String): String = "$thumbBase/${thumbName(cat)}.$THUMB_EXT"

    // 카드 주소에 종목과 정렬을 담는다. 전체 카드는 기존 주소와 같아서 저장된 항목과 이어진다
    private fun cardUrl(cat: String, sort: String): String {
        val base = "/live2?cat=" + URLEncoder.encode(cat, "UTF-8")
        return if (sort == SORT_TIME) "$base&sort=time" else base
    }

    private fun makeCard(cat: String, sort: String, count: Int? = null): SAnime = SAnime.create().apply {
        title = cardTitle(cat) + if (count != null) " · ${count}경기" else ""
        thumbnail_url = thumbUrl(cat)
        setUrlWithoutDomain(cardUrl(cat, sort))
    }

    // 카드 주소에서 (종목, 정렬)을 읽는다
    private fun cardParams(animeUrl: String): Pair<String, String> {
        val u = "https://local.invalid$animeUrl".toHttpUrlOrNull()
        val cat = u?.queryParameter("cat") ?: ALL_CAT
        val sort = if (u?.queryParameter("sort") == "time") SORT_TIME else SORT_CATEGORY
        return cat to sort
    }

    // 요청 주소에 붙여 둔 (종목, 정렬)을 읽는다
    private fun paramsOf(url: HttpUrl): Pair<String, String> {
        val cat = url.queryParameter("ls_cat") ?: ALL_CAT
        val sort = if (url.queryParameter("ls_sort") == SORT_TIME) SORT_TIME else SORT_CATEGORY
        return cat to sort
    }

    // 사이트로 보내는 요청에 종목/정렬 값을 실어, 응답을 해석할 때 꺼내 쓴다
    // (목록을 가져오는 숨은 화면은 이 값 없이 원래 주소를 연다)
    private fun pageUrlWith(cat: String, sort: String): String =
        livePageUrl.toHttpUrl().newBuilder()
            .addQueryParameter("ls_cat", cat)
            .addQueryParameter("ls_sort", sort)
            .build()
            .toString()

    // 선택한 종목과 정렬에 해당하는 카드들을 만든다
    // 경기 목록을 읽었으면 경기가 있는 종목만, 카드 제목 옆에 경기 수. 못 읽었으면 예전처럼 모든 종목 카드
    private fun cardsFor(choice: String, sort: String): List<SAnime> {
        val items = currentItems()
        val hideTv = pref(PREF_HIDE_TV, false)
        fun card(cat: String) =
            if (items.isEmpty()) makeCard(cat, sort) else makeCard(cat, sort, items.count { inCat(it, cat, hideTv) })
        return when {
            choice == CHOICE_EACH -> {
                val cats = CATEGORY_ORDER + LABEL_TV + CAT_OTHER
                val shown = if (items.isEmpty()) cats else cats.filter { c -> items.any { inCat(it, c, false) } }
                listOf(card(ALL_CAT)) + shown.map { card(it) }
            }
            isAllCat(choice) -> listOf(card(ALL_CAT))
            else -> listOf(card(choice))
        }
    }

    // ---- 인기/최신 탭에 저장된 규칙 ----
    // 기본값: 인기 = 전체 카드 하나, 최신 = 종목별 카드 모두
    private fun savedRule(popular: Boolean): Pair<String, String> {
        val p = prefs()
        val defChoice = if (popular) CHOICE_ALL else CHOICE_EACH
        val choice = p?.getString(if (popular) PREF_POP_CHOICE else PREF_LATEST_CHOICE, defChoice)
            ?.takeIf { it in CATEGORY_CHOICES } ?: defChoice
        val sort = p?.getString(if (popular) PREF_POP_SORT else PREF_LATEST_SORT, SORT_CATEGORY)
            ?.takeIf { it == SORT_TIME || it == SORT_CATEGORY } ?: SORT_CATEGORY
        return choice to sort
    }

    private fun saveRule(popular: Boolean, choice: String, sort: String) {
        prefs()?.edit()
            ?.putString(if (popular) PREF_POP_CHOICE else PREF_LATEST_CHOICE, choice)
            ?.putString(if (popular) PREF_POP_SORT else PREF_LATEST_SORT, sort)
            ?.apply()
    }

    private fun resetRule(popular: Boolean) {
        prefs()?.edit()
            ?.remove(if (popular) PREF_POP_CHOICE else PREF_LATEST_CHOICE)
            ?.remove(if (popular) PREF_POP_SORT else PREF_LATEST_SORT)
            ?.apply()
    }

    private fun ruleText(choice: String, sort: String): String {
        val c = if (choice == CHOICE_ALL) "전체" else choice
        return "$c · ${if (sort == SORT_TIME) "시간순" else "종목순"}"
    }

    // 인기 탭: 저장된 규칙(없으면 기본값)으로 카드를 보여준다
    override fun popularAnimeRequest(page: Int): Request = GET(livePageUrl, headers)

    override fun popularAnimeParse(response: Response): AnimesPage {
        val (choice, sort) = savedRule(true)
        return AnimesPage(cardsFor(choice, sort), false)
    }

    // 최신 탭: 저장된 규칙(없으면 기본값)으로 카드를 보여준다
    override fun latestUpdatesRequest(page: Int): Request = GET(livePageUrl, headers)

    override fun latestUpdatesParse(response: Response): AnimesPage {
        val (choice, sort) = savedRule(false)
        return AnimesPage(cardsFor(choice, sort), false)
    }

    // 필터 적용: 선택한 조건의 카드를 보여주고, "탭 규칙"을 골랐으면 저장/복원도 함께 한다
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        var choice = CHOICE_ALL
        var sort = SORT_CATEGORY
        var rule = 0
        filters.forEach { filter ->
            when (filter) {
                is CategoryFilter -> choice = CATEGORY_CHOICES[filter.state]
                is SortFilter -> sort = if (filter.state == 1) SORT_TIME else SORT_CATEGORY
                is RuleFilter -> rule = filter.state
                else -> {}
            }
        }
        when (rule) {
            1 -> saveRule(true, choice, sort)
            2 -> saveRule(false, choice, sort)
            3 -> resetRule(true)
            4 -> resetRule(false)
            5 -> {
                resetRule(true)
                resetRule(false)
            }
        }
        return GET(pageUrlWith(choice, sort), headers)
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val (choice, sort) = paramsOf(response.request.url)
        return AnimesPage(cardsFor(choice, sort), false)
    }

    override fun animeDetailsRequest(anime: SAnime): Request {
        val (cat, sort) = cardParams(anime.url)
        return GET(pageUrlWith(cat, sort), headers)
    }

    override fun animeDetailsParse(response: Response): SAnime {
        val (cat, sort) = paramsOf(response.request.url)
        return SAnime.create().apply {
            title = cardTitle(cat)
            thumbnail_url = thumbUrl(cat)
            status = SAnime.ONGOING
            val catText = if (isAllCat(cat)) "전체" else cat
            description = "종목: $catText · 정렬: ${if (sort == SORT_TIME) "시간순" else "종목순"}"
        }
    }

    override fun episodeListRequest(anime: SAnime): Request {
        val (cat, sort) = cardParams(anime.url)
        return GET(pageUrlWith(cat, sort), headers)
    }

    override fun videoListRequest(episode: SEpisode): Request {
        val data = episode.url.substringAfter("stream_data=", "").substringBefore("&n=")
        return GET("$livePageUrl&stream_data=$data", headers)
    }

    // 필터 화면 (종목 선택, 정렬, 인기/최신 탭 규칙)
    class CategoryFilter(choices: Array<String>) : AnimeFilter.Select<String>("종목", choices)
    class SortFilter(choices: Array<String>) : AnimeFilter.Select<String>("정렬", choices)
    class RuleFilter(choices: Array<String>) : AnimeFilter.Select<String>("인기/최신 탭 규칙", choices)

    override fun getFilterList(): AnimeFilterList {
        val (pc, ps) = savedRule(true)
        val (lc, ls) = savedRule(false)
        return ExtStatus.prepend(
            "livesports",
            baseUrl,
            pref(PREF_AUTO_DOMAIN, true),
            AnimeFilterList(
                AnimeFilter.Header("종목을 고르면 해당 종목 카드만 표시됩니다"),
                CategoryFilter(CATEGORY_CHOICES),
                SortFilter(SORT_CHOICES),
                AnimeFilter.Separator(),
                AnimeFilter.Header("기본 인기: 전체 경기 · 기본 최신: 종목별 카드 모두"),
                AnimeFilter.Header("현재 인기: ${ruleText(pc, ps)}"),
                AnimeFilter.Header("현재 최신: ${ruleText(lc, ls)}"),
                RuleFilter(RULE_CHOICES),
            ),
        )
    }

    // ================= 2. JSON 해석 =================
    private val nameKeys = listOf("name", "title", "label", "channel", "text", "match", "game")
    private val urlKeys = listOf("stream", "streamKey", "key", "url", "src", "file", "hls", "slug", "path", "id")
    private val skipKeys = listOf("date", "time", "image", "img", "logo", "thumb", "poster", "icon", "league", "status")

    // 최상위 배열이거나, 객체 안의 첫 번째 "객체 배열"을 찾음 (암호문 래퍼 {"iv","value"}는 null)
    private fun findArray(text: String): JSONArray? {
        val t = text.trim()
        if (t.startsWith("[")) return JSONArray(t)
        if (!t.startsWith("{")) return null
        val obj = JSONObject(t)
        val keys = obj.keys()
        while (keys.hasNext()) {
            val v = obj.opt(keys.next())
            if (v is JSONArray && v.length() > 0 && v.optJSONObject(0) != null) return v
        }
        return null
    }

    private fun looksLikeStreams(arr: JSONArray): Boolean {
        val first = arr.optJSONObject(0) ?: return false
        return first.length() >= 2
    }

    private fun firstString(item: JSONObject, keys: List<String>): String {
        for (k in keys) {
            val v = item.opt(k)
            if (v is String && v.isNotEmpty()) return v
            if (v is Number) return v.toString()
        }
        return ""
    }

    // 중첩된 객체/배열까지 포함해 (키, 문자열 값) 목록을 수집
    private fun collectStrings(node: Any?, key: String, out: MutableList<Pair<String, String>>) {
        when (node) {
            is JSONObject -> {
                val it = node.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    collectStrings(node.opt(k), k, out)
                }
            }
            is JSONArray -> for (i in 0 until node.length()) collectStrings(node.opt(i), key, out)
            is String -> out.add(key to node)
            else -> {}
        }
    }

    // 영상 키처럼 보이는 값: 8~24자, 영문 대/소문자 + 숫자가 모두 섞여 있음 (예: OK1jlJ6naKK)
    private fun looksLikeStreamKey(v: String): Boolean {
        if (!Regex("^[A-Za-z0-9_-]{8,24}$").matches(v)) return false
        return v.any { it.isUpperCase() } && v.any { it.isLowerCase() } && v.any { it.isDigit() }
    }

    private fun pickStreamData(item: JSONObject): String {
        val all = mutableListOf<Pair<String, String>>()
        collectStrings(item, "", all)

        // 1순위: m3u8이 들어간 완성 URL
        all.firstOrNull { it.second.startsWith("http") && it.second.contains(".m3u8") }
            ?.let { return it.second }

        // 2순위: 영상 키처럼 생긴 값 (이름/날짜/이미지 계열 필드는 제외)
        all.firstOrNull { (k, v) ->
            k.lowercase() !in nameKeys && skipKeys.none { s -> k.lowercase().contains(s) } && looksLikeStreamKey(v)
        }?.let { return it.second }

        // 3순위: 알려진 필드명
        return firstString(item, urlKeys)
    }

    // 경기 종류(category)를 한글 종목명으로 바꿈. 모르는 값은 영어 원문 그대로 표시
    private fun categoryLabel(item: JSONObject): String {
        val raw = item.optString("category").ifEmpty { item.optString("categoryName") }.trim()
        if (raw.isEmpty()) return ""
        return when (raw.lowercase().replace(CATEGORY_SEPARATOR_REGEX, "")) {
            "football", "soccer" -> "축구"
            "basketball" -> "농구"
            "baseball" -> "야구"
            "volleyball" -> "배구"
            "hockey", "icehockey" -> "하키"
            "tennis" -> "테니스"
            "americanfootball", "nfl" -> "미식축구"
            "lol", "esports", "leagueoflegends" -> "롤"
            "boxing" -> "복싱"
            "tv" -> LABEL_TV
            else -> raw
        }
    }

    // 종목별 이모지 (색이 있어서 목록에서 종목이 눈에 띄게 구분됨). 모르는 종목은 🏅
    private fun categoryEmoji(label: String): String = when (label) {
        "" -> ""
        "축구" -> "⚽"
        "야구" -> "⚾"
        "농구" -> "🏀"
        "배구" -> "🏐"
        "하키" -> "🏒"
        "테니스" -> "🎾"
        "미식축구" -> "🏈"
        "롤" -> "🎮"
        "복싱" -> "🥊"
        LABEL_TV -> "📺"
        else -> "🏅"
    }

    private class ParsedItem(
        val title: String,
        val streamData: String,
        val league: String,
        val label: String,
        val startKey: String,
    )

    // 목록에 실제로 표시되는 한 줄 (경기 또는 구분 줄)
    private class Row(
        val name: String,
        val url: String,
        val scanlator: String?,
    )

    // 정렬 순서: 알려진 종목(CATEGORY_ORDER 순) → 그 밖의 종목(영어 원문) → 종목 없음 → TV 채널
    private fun categoryRank(label: String): Int = when {
        label == LABEL_TV -> CATEGORY_ORDER.size + 2
        label.isEmpty() -> CATEGORY_ORDER.size + 1
        else -> CATEGORY_ORDER.indexOf(label).let { if (it >= 0) it else CATEGORY_ORDER.size }
    }

    // 가로챈 JSON에서 경기 항목을 읽는다 (원래 순서 그대로, 종목/정렬은 나중에 적용)
    private fun parseItems(jsonText: String): List<ParsedItem> {
        val array = findArray(jsonText) ?: return emptyList()
        firstItemDebug = array.opt(0).toString().take(400)

        val items = mutableListOf<ParsedItem>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val streamData = pickStreamData(item)
            if (streamData.isEmpty()) continue

            val baseTitle = firstString(item, nameKeys).ifEmpty { "실시간 경기 ${items.size + 1}" }
            val league = item.optString("league").trim().takeIf { it != "null" }.orEmpty()
            val date = item.optString("schedule_date").trim().takeIf { it != "null" }.orEmpty()
            val time = item.optString("schedule_time").trim().takeIf { it != "null" }.orEmpty()

            items.add(
                ParsedItem(
                    title = baseTitle,
                    streamData = streamData,
                    league = league,
                    label = categoryLabel(item),
                    startKey = "$date $time".trim(),
                ),
            )
        }
        return items
    }

    // "2026-10-02 00:00" -> "시작 10-02 00:00" (날짜나 시각이 없으면 표시 안 함)
    private fun startLabel(key: String): String =
        if (key.length >= 16) "시작 ${key.substring(5, 16)}" else ""

    private fun infoEpisode(msg: String) = SEpisode.create().apply {
        name = "ℹ️ $msg"
        episode_number = 1f
        url = "/play?stream_data=none"
    }

    // 선택한 종목/정렬/설정에 맞춰 화면에 보일 에피소드 목록을 만든다
    private fun buildEpisodes(
        items: List<ParsedItem>,
        cat: String,
        sort: String,
        staleTime: String?,
    ): List<SEpisode> {
        val hideTv = pref(PREF_HIDE_TV, false)
        val useEmoji = pref(PREF_EMOJI, true)
        val headerSetting = pref(PREF_HEADERS, true)
        val showStart = pref(PREF_START_TIME, true)

        // 1) 종목으로 거르기 (TV는 전체 보기에서만 숨길 수 있고, 직접 고르면 보인다)
        val filtered = items.filter { inCat(it, cat, hideTv) }
        if (filtered.isEmpty()) {
            return listOf(infoEpisode("현재 방송 중인 경기가 없습니다"))
        }

        // 2) 정렬. 같은 값끼리는 기존처럼 목록 순서를 뒤집어 표시 (sortedWith는 순서를 유지하는 안정 정렬)
        val ordered = if (sort == SORT_TIME) {
            filtered.reversed().sortedBy { it.startKey.ifEmpty { "9999-99-99 99:99" } }
        } else {
            filtered.reversed().sortedWith(
                compareBy<ParsedItem>(
                    { categoryRank(it.label) },
                    { if (categoryRank(it.label) == CATEGORY_ORDER.size) it.label else "" },
                ),
            )
        }

        val counts = ordered.groupingBy { it.label }.eachCount()
        val showHeaders = headerSetting && sort == SORT_CATEGORY && (isAllCat(cat) || cat == CAT_OTHER)
        val staleTag = staleTime?.let { "이전 목록 ($it)" }

        // 3) 구분 줄과 경기 줄 만들기
        val rows = mutableListOf<Row>()
        var lastLabel: String? = null
        for (p in ordered) {
            val emoji = if (useEmoji) categoryEmoji(p.label) else ""

            // 종목이 바뀔 때 구분 줄을 넣음 (같은 주소로 합쳐지지 않도록 줄 번호를 붙임)
            if (showHeaders && p.label != lastLabel) {
                val head = listOf(emoji, p.label.ifEmpty { "기타" }, "(${counts[p.label]})")
                    .filter { it.isNotEmpty() }
                    .joinToString(" ")
                rows.add(Row("━━ $head ━━", "/play?stream_data=header&n=${rows.size}", null))
            }
            lastLabel = p.label

            rows.add(
                Row(
                    name = when {
                        p.label.isEmpty() -> p.title
                        useEmoji -> "$emoji ${p.title}"
                        else -> "[${p.label}] ${p.title}"
                    },
                    url = "/play?stream_data=" + URLEncoder.encode(p.streamData, "UTF-8"),
                    // 시작 시각, 종목명, 대회명은 날짜 옆 줄에 표시 (제목이 길어도 잘리지 않음)
                    scanlator = listOf(
                        staleTag.orEmpty(),
                        if (showStart) startLabel(p.startKey) else "",
                        p.label,
                        p.league,
                    )
                        .filter { it.isNotEmpty() }
                        .joinToString(" · ")
                        .ifEmpty { null },
                ),
            )
        }

        // 앱이 "Missing N items"를 표시하지 않도록 위에서 아래로 번호를 연속으로 매김
        return rows.mapIndexed { index, r ->
            SEpisode.create().apply {
                this.name = r.name
                this.episode_number = (rows.size - index).toFloat()
                this.scanlator = r.scanlator
                this.url = r.url
            }
        }
    }

    // ================= 3. 부모 페이지를 WebView로 열어 가로채기 =================
    // 플레이어 JS가 복호화한 뒤 JSON.parse에 넘기는 문자열을 낚아챈다
    private val hookPrefix = """
        (function(){
          if (window.__lsHook) return;
          window.__lsHook = true;
          var o = JSON.parse;
          JSON.parse = function(t) {
            try {
              if (typeof t === 'string' && t.length > 20 && (t.charAt(0) === '[' || t.charAt(0) === '{')) {
                var b = window.Android;
                if (!b) { try { b = window.top.Android; } catch (e) {} }
                if (b) b.onData(t);
              }
            } catch (e) {}
            return o.apply(this, arguments);
          };
        })();
    """.trimIndent()

    // 동시에 두 번 실행되지 않게 하고, 짧은 시간 안에 다시 호출되면 이전 결과를 재사용
    @Synchronized
    private fun ensureCaptured() {
        if (capturedJson == null || System.currentTimeMillis() - lastCaptureTime > CACHE_MS) {
            captureFromPage()
            lastCaptureTime = System.currentTimeMillis()
        }
    }

    @Synchronized
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun captureFromPage() {
        capturedJson = null
        capturedM3u8 = null
        candidateHeads = ""

        val pageUrl = livePageUrl
        val pageReferer = "$baseUrl/"
        val latch = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        var webViewRef: WebView? = null

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
                webView.settings.userAgentString = headersBuilder().build()["User-Agent"]

                webView.addJavascriptInterface(
                    object {
                        @JavascriptInterface
                        fun onData(data: String) {
                            if (candidateHeads.length < 300) {
                                candidateHeads += " [" + data.take(50).replace("\n", " ") + "]"
                            }
                            if (capturedJson == null) {
                                val arr = try { findArray(data) } catch (e: Exception) { null }
                                if (arr != null && arr.length() > 0 && looksLikeStreams(arr)) {
                                    capturedJson = data
                                    latch.countDown()
                                }
                            }
                        }
                    },
                    "Android",
                )

                webView.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest,
                    ): WebResourceResponse? {
                        val uri = request.url
                        val url = uri.toString()
                        val host = uri.host ?: ""
                        val path = uri.path ?: ""

                        // 목록 추출에 필요 없는 채팅 위젯/이미지/폰트는 빈 응답으로 차단
                        if (host.endsWith("vchat24.com") || blockedAssets.matches(path)) {
                            return WebResourceResponse(
                                "text/plain",
                                "UTF-8",
                                ByteArrayInputStream(ByteArray(0)),
                            )
                        }

                        if (host.endsWith(".xvqz.org") && path.startsWith("/build/")) {
                            iframeHost = host
                        }

                        // 플레이어 JS 맨 앞에 JSON.parse 후킹 코드를 붙여서 제공
                        if (host.endsWith(".xvqz.org") && path.endsWith(".js")) {
                            try {
                                val rb = Request.Builder().url(url)
                                request.requestHeaders.forEach { (k, v) ->
                                    if (!k.equals("Accept-Encoding", true)) rb.header(k, v)
                                }
                                val body = client.newCall(rb.build()).execute().use { res ->
                                    if (res.isSuccessful) res.body?.string() else null
                                }
                                if (body != null) {
                                    val hooked = hookPrefix + "\n" + body
                                    return WebResourceResponse(
                                        "application/javascript",
                                        "UTF-8",
                                        200,
                                        "OK",
                                        mapOf("Access-Control-Allow-Origin" to "*"),
                                        ByteArrayInputStream(hooked.toByteArray(Charsets.UTF_8)),
                                    )
                                }
                            } catch (e: Exception) {
                                Log.d(tag, "js hook failed: ${e.message}")
                            }
                        }

                        if (url.contains(".m3u8") && capturedM3u8 == null) {
                            capturedM3u8 = url
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }

                webView.loadUrl(pageUrl, mutableMapOf("Referer" to pageReferer))
            } catch (e: Exception) {
                Log.d(tag, "webview error: ${e.message}")
                latch.countDown()
            }
        }

        latch.await(15, TimeUnit.SECONDS)
        // 목록 JSON에 m3u8 주소가 이미 들어 있으면 기다리지 않음 (영상 호스트 확보용 대기)
        var waited = 0
        while (capturedM3u8 == null && capturedJson?.contains(".m3u8") != true && waited < 6000) {
            Thread.sleep(250)
            waited += 250
        }

        handler.post {
            webViewRef?.stopLoading()
            webViewRef?.destroy()
        }

        // 영상 호스트: 가로챈 m3u8 요청에서, 없으면 목록 JSON 안의 m3u8 주소에서 읽음
        val liveFromJson = capturedJson?.let {
            Regex("""https?://[^"\\\s]+\.m3u8[^"\\\s]*""").find(it.replace("\\/", "/"))?.value
        }
        (capturedM3u8 ?: liveFromJson)?.let { liveHost = Uri.parse(it).host }
        Log.d(tag, "iframeHost=$iframeHost liveHost=$liveHost json=${capturedJson?.length}")
    }

    // ================= 4. 실시간 경기 목록 =================
    private fun m3u8Episode(url: String) = SEpisode.create().apply {
        name = "실시간 라이브 채널 (자동감지)"
        episode_number = 1f
        this.url = "/play?stream_data=" + URLEncoder.encode(url, "UTF-8")
    }

    // 목록을 불러오지 못했을 때 원인을 보여주는 줄
    private fun debugEpisode(msg: String) = SEpisode.create().apply {
        name = "DEBUG: $msg"
        episode_number = -1f
        this.url = "/play?stream_data=debug"
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val (cat, sort) = paramsOf(response.request.url)

        ensureCaptured()

        val json = capturedJson
        val items = if (json != null) {
            try { parseItems(json) } catch (e: Exception) { emptyList() }
        } else {
            emptyList()
        }

        // 성공: 정상 항목을 기억해 두고, 선택한 종목/정렬로 목록을 만든다
        if (items.isNotEmpty()) {
            lastGoodItems = items
            lastGoodTime = System.currentTimeMillis()
            return buildEpisodes(items, cat, sort, null)
        }

        // 실패: 직전 정상 항목이 최근(30분 이내)이면 그것으로 목록을 만든다
        val saved = lastGoodItems
        if (saved.isNotEmpty() && System.currentTimeMillis() - lastGoodTime < LAST_GOOD_MAX_AGE_MS) {
            Log.d(tag, "목록 가져오기 실패, 이전 목록 사용 json=${json?.take(60)} iframe=$iframeHost")
            val time = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(lastGoodTime))
            return buildEpisodes(saved, cat, sort, time)
        }

        // 이전 목록도 없으면: 자동감지 채널 + 원인 확인용 DEBUG 줄
        val result = mutableListOf<SEpisode>()
        capturedM3u8?.let { result.add(m3u8Episode(it)) }
        result.add(
            debugEpisode(
                "json=${json?.take(60)} cand=$candidateHeads m3u8=${capturedM3u8 != null} iframe=$iframeHost",
            ),
        )
        return result
    }

    // ================= 5. 로컬 프록시 =================
    // 플레이어(mpv)가 직접 요청하면 400을 받으므로, 플레이어는 127.0.0.1로 요청하고
    // 실제 요청은 앱(OkHttp)이 대신 보낸다. 재생목록 안의 주소도 모두 이 프록시로 돌린다.
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

            val targetHost = try { target.toHttpUrl().host } catch (e: Exception) { "" }
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
                // ignore
            }
        }
    }

    // ================= 6. 비디오 재생 =================
    private data class Candidate(
        val sub200: Boolean,
        val label: String,
        val url: String,
        val headers: Headers,
        val result: String,
    )

    private fun cookieHeader(url: String): String = try {
        client.cookieJar.loadForRequest(url.toHttpUrl()).joinToString("; ") { "${it.name}=${it.value}" }
    } catch (e: Exception) {
        ""
    }

    // Referer/Origin(/쿠키) 조합 후보. 확인된 xvqz+Origin을 맨 앞에 둠
    private fun headerVariants(url: String): List<Pair<String, Headers>> {
        val ua = headersBuilder().build()["User-Agent"]!!
        val iframeRef = iframeHost?.let { "https://$it/" }
        val cookie = cookieHeader(url)

        fun build(ref: String?, withOrigin: Boolean, withCookie: Boolean = false): Headers {
            val b = Headers.Builder().set("User-Agent", ua).set("Accept", "*/*")
            if (ref != null) {
                b.set("Referer", ref)
                if (withOrigin) b.set("Origin", ref.trimEnd('/'))
            }
            if (withCookie && cookie.isNotEmpty()) b.set("Cookie", cookie)
            return b.build()
        }

        val list = mutableListOf<Pair<String, Headers>>()
        list.add("xvqz+Origin" to build("https://xvqz.org/", true))
        if (iframeRef != null) list.add("iframe+Origin" to build(iframeRef, true))
        if (cookie.isNotEmpty()) list.add("xvqz+Origin+쿠키" to build("https://xvqz.org/", true, true))
        list.add("njtv+Origin" to build("$baseUrl/", true))
        list.add("UA만" to build(null, false))
        return list
    }

    // m3u8과 그 안의 첫 하위 주소(조각/변형 목록)까지 요청해 결과 코드를 문자열로 반환
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

    override fun videoListParse(response: Response): List<Video> {
        val data = response.request.url.queryParameter("stream_data") ?: ""
        if (data.isEmpty()) {
            throw Exception("stream_data 비어있음")
        }
        if (data == "header") {
            throw Exception("구분 줄입니다. 아래의 경기를 선택하세요")
        }
        if (data == "none") {
            throw Exception("현재 방송 중인 경기가 없습니다")
        }
        if (data == "debug") {
            throw Exception("원인 확인용 줄입니다. item=$firstItemDebug")
        }

        val mirrors = listOfNotNull(
            liveHost,
            "ol3ktizakokhjhnu.kjhsdfuie.work",
            "daxnb7e8nd4e0hdj.kjhsdfuie.work",
        ).distinct()

        val parsed = if (data.startsWith("http")) {
            try { data.toHttpUrl() } catch (e: Exception) { null }
        } else {
            null
        }

        val site = siteHost

        // 완성 URL이면 원래 호스트를 먼저, 이어서 다른 호스트로 바꾼 주소도 시도
        val playUrls: List<String> = when {
            parsed != null && parsed.host.endsWith(".kjhsdfuie.work") ->
                (listOf(parsed.host) + mirrors).distinct().map { h ->
                    if (h == parsed.host) data else parsed.newBuilder().host(h).build().toString()
                }
            parsed != null -> listOf(data)
            else -> mirrors.map { "https://$it/live/$data/playlist.m3u8?site=$site" }
        }

        fun hostTag(u: String): String = try {
            u.toHttpUrl().host.take(5)
        } catch (e: Exception) {
            "?"
        }

        val log = mutableListOf<String>()
        val ok = mutableListOf<Candidate>()

        for (u in playUrls) {
            for ((label, h) in headerVariants(u)) {
                val r = probe(u, h)
                log.add("${hostTag(u)}:${r.take(9)}")
                if (r.startsWith("m3u8=200")) {
                    ok.add(Candidate(r.contains("sub=200"), label, u, h, r))
                }
                // 하위 주소까지 통과하면 중단, 404면 헤더를 바꿔도 같으므로 다음 호스트로
                if (r.contains("sub=200") || r.startsWith("m3u8=404")) break
            }
            if (ok.isNotEmpty()) break
        }

        if (ok.isEmpty()) {
            val key = parsed?.encodedPath?.removePrefix("/live/")?.substringBefore("/") ?: data
            val all404 = log.isNotEmpty() && log.all { it.contains("m3u8=404") }
            throw Exception("[${key.take(14)}] " + (if (all404) "404 " else "") + log.joinToString(" | "))
        }

        val best = ok.sortedByDescending { it.sub200 }.first()

        // 로컬 프록시 (앱이 통과한 헤더로 대신 요청). 직접 재생은 플레이어에서 400이라 제외
        val port = ensureProxy()
        proxyHeaders = best.headers
        try {
            allowedHosts.add(best.url.toHttpUrl().host)
        } catch (e: Exception) {
            // 무시
        }
        val proxied = proxyUrl(port, best.url)
        return listOf(Video(proxied, "프록시 [${best.label}]", proxied, Headers.Builder().build()))
    }

    override fun videoUrlParse(response: Response): String = ""

    // ================= 7. 설정 화면 =================
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
            dialogMessage = "https:// 로 시작하는 주소를 입력하세요. 예: https://njtv-02.com"
            setDefaultValue("")

            setOnPreferenceChangeListener { _, newValue ->
                val input = (newValue as String).trim().trimEnd('/')
                when {
                    input.isEmpty() -> {
                        summary = summaryOf(DEFAULT_BASE_URL)
                        lastCaptureTime = 0L
                        lastGoodItems = emptyList()
                        Toast.makeText(ctx, "기본 주소로 되돌렸습니다.", Toast.LENGTH_SHORT).show()
                        true
                    }
                    DOMAIN_REGEX.matches(input) -> {
                        summary = summaryOf(input)
                        lastCaptureTime = 0L
                        lastGoodItems = emptyList()
                        Toast.makeText(ctx, "주소가 변경되었습니다: $input", Toast.LENGTH_SHORT).show()
                        true
                    }
                    else -> {
                        Toast.makeText(
                            ctx,
                            "올바른 주소 형식이 아닙니다 (예: https://njtv-02.com)",
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
                "접속이 안 되거나 막히면 njtv-01~60.com 중 열리는 주소로 자동 변경합니다. " +
                    "사이트가 새 주소로 넘겨 주면 그 주소도 저장합니다.",
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
                "날짜 옆 줄에 시작 시각(예: 시작 10-02 00:00)을 표시합니다. 바꾼 뒤 목록을 새로고침하세요.",
                true,
            ),
        )

        // ---- [전용] 이 확장만 ----
        screen.addPreference(
            switchPref(
                PREF_HIDE_TV,
                "[전용] TV 채널 숨기기",
                "전체 보기에서 TV 채널 항목을 숨깁니다. 필터에서 TV를 직접 고르면 보입니다.",
                false,
            ),
        )
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_THUMB_BASE = "pref_thumb_base"
        private const val PREF_HEADERS = "pref_section_headers"
        private const val PREF_EMOJI = "pref_emoji"
        private const val PREF_START_TIME = "pref_start_time"
        private const val PREF_HIDE_TV = "pref_hide_tv"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"

        // 인기/최신 탭에 저장하는 규칙
        private const val PREF_POP_CHOICE = "pref_pop_choice"
        private const val PREF_POP_SORT = "pref_pop_sort"
        private const val PREF_LATEST_CHOICE = "pref_latest_choice"
        private const val PREF_LATEST_SORT = "pref_latest_sort"

        private const val DEFAULT_BASE_URL = "https://njtv-01.com"

        // 카드 표지 이미지: <폴더>/<이름>.<확장자> (확장자를 바꾸려면 THUMB_EXT만 고치면 됨)
        private const val DEFAULT_THUMB_BASE =
            "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/thumbs"
        private const val THUMB_EXT = "png"

        private const val LABEL_TV = "TV"

        // 카드 주소와 필터에서 쓰는 값
        private const val ALL_CAT = "전체 경기"
        private const val CAT_OTHER = "기타"
        private const val CHOICE_ALL = "전체"
        private const val CHOICE_EACH = "종목별 카드 모두"
        private const val SORT_CATEGORY = "category"
        private const val SORT_TIME = "time"

        // 목록 캐시 시간 (이 시간 안에 다시 열면 숨은 화면을 다시 열지 않음)
        private const val CACHE_MS = 20_000L

        // 가져오기에 실패했을 때 직전 정상 목록을 보여줄 수 있는 최대 시간
        private const val LAST_GOOD_MAX_AGE_MS = 30 * 60 * 1000L

        // 목록에 보이는 종목 순서 (바꾸고 싶으면 이 목록의 순서를 고치세요)
        private val CATEGORY_ORDER = listOf(
            "축구", "야구", "농구", "배구", "하키", "테니스", "미식축구", "롤", "복싱",
        )

        // 필터의 종목 선택지
        private val CATEGORY_CHOICES: Array<String> =
            (listOf(CHOICE_ALL, CHOICE_EACH) + CATEGORY_ORDER + LABEL_TV + CAT_OTHER).toTypedArray()

        private val SORT_CHOICES: Array<String> = arrayOf("종목순", "시간순")

        // 인기/최신 탭 규칙 선택지 (번호 순서가 searchAnimeRequest의 처리와 일치해야 함)
        private val RULE_CHOICES: Array<String> = arrayOf(
            "저장하지 않음 (필터 결과만 보기)",
            "현재 조건을 인기 탭에 저장",
            "현재 조건을 최신 탭에 저장",
            "인기 탭을 기본값으로 복원",
            "최신 탭을 기본값으로 복원",
            "두 탭 모두 기본값으로 복원",
        )

        private val DOMAIN_REGEX = Regex("""^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$""")
        private val HOST_REGEX = Regex("""^njtv-(\d+)\.com$""")

        // 실제 사이트 확인용 표시 (그누보드 페이지, 라이브 TV 메뉴)
        private val SITE_MARKER = Regex("""g5_url|gnuboard|livetv""", RegexOption.IGNORE_CASE)
        private val THUMB_BASE_REGEX = Regex("""^https://\S+$""")
        private val CATEGORY_SEPARATOR_REGEX = Regex("""[\s_-]""")
    }
}
