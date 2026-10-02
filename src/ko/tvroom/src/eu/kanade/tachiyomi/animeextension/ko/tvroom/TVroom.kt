package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.app.Application
import android.content.SharedPreferences
import android.os.Looper
import android.util.Base64
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.ParsedAnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class TVroom : ParsedAnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "티비위키"
    override val lang = "ko"
    override val supportsLatest = true

    // ================= 주소 관리 =================
    @Volatile private var prefsCache: SharedPreferences? = null

    // 안드로이드 기본 프레임워크 리플렉션으로 SharedPreferences 획득 (성공하면 재사용)
    private fun getAppPreferences(): SharedPreferences? {
        prefsCache?.let { return it }
        return runCatching {
            val actThreadClass = Class.forName("android.app.ActivityThread")
            val currentAppMethod = actThreadClass.getMethod("currentApplication")
            val app = currentAppMethod.invoke(null) as? Application
            app?.getSharedPreferences("source_$id", 0)
        }.getOrNull()?.also { prefsCache = it }
    }

    private fun customDomain(prefs: SharedPreferences?): String? =
        prefs?.getString(PREF_DOMAIN_KEY, "")?.trim()?.trimEnd('/')
            ?.takeIf { it.isNotBlank() && DOMAIN_REGEX.matches(it) }

    private fun lastGoodDomain(prefs: SharedPreferences?): String =
        prefs?.getString(PREF_LAST_GOOD_DOMAIN_KEY, DEFAULT_BASE_URL)
            ?.takeIf { DOMAIN_REGEX.matches(it) } ?: DEFAULT_BASE_URL

    // 네트워크를 호출하지 않는 현재 주소 (설정 화면 표시용)
    private fun currentDomainNoNetwork(): String {
        val prefs = getAppPreferences()
        return customDomain(prefs) ?: cachedDomain ?: lastGoodDomain(prefs)
    }

    private val signalClient: OkHttpClient by lazy {
        client.newBuilder().callTimeout(5, TimeUnit.SECONDS).build()
    }

    // 중앙신호등 조회 (잠금 안에서만 호출)
    private fun resolveDomain(prefs: SharedPreferences?): String {
        // 기다리는 사이 다른 스레드가 먼저 갱신했을 수 있음
        cachedDomain?.let { if (System.currentTimeMillis() < cacheValidUntil) return it }

        val lastGood = lastGoodDomain(prefs)
        val fetched = runCatching {
            val req = Request.Builder()
                .url(SIGNAL_URL)
                .header("User-Agent", defaultUserAgent)
                .header("Accept", "application/json")
                .build()
            signalClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@use null
                JSONObject(res.body.string()).optString("tvwiki").trim().trimEnd('/')
            }
        }.getOrNull()

        if (!fetched.isNullOrBlank() && DOMAIN_REGEX.matches(fetched)) {
            // 신호등이 이미 막힌 주소나, 마지막으로 접속에 성공한 주소보다 낮은 번호(예전 주소)를 알려 주면
            // 접속에 성공했던 주소를 계속 쓴다
            val stale = autoDomain(prefs) &&
                (fetched in deadDomains || domainNumber(fetched) < domainNumber(lastGood))
            val chosen = if (stale) lastGood else fetched
            cachedDomain = chosen
            cacheValidUntil = System.currentTimeMillis() + CACHE_TTL_MS
            return chosen
        }

        // 실패: 마지막 정상 주소를 쓰되 1분 뒤 다시 시도
        cachedDomain = lastGood
        cacheValidUntil = System.currentTimeMillis() + RETRY_TTL_MS
        return lastGood
    }

    override val baseUrl: String
        get() {
            val prefs = getAppPreferences()

            // 1순위: 사용자가 직접 지정한 주소
            customDomain(prefs)?.let { return it }

            // 2순위: 유효한 메모리 캐시
            cachedDomain?.let { if (System.currentTimeMillis() < cacheValidUntil) return it }

            // 메인 스레드에서는 네트워크를 호출하지 않고 캐시도 건드리지 않음
            if (Looper.myLooper() == Looper.getMainLooper()) {
                return cachedDomain ?: lastGoodDomain(prefs)
            }

            // 3~4순위: 신호등 조회, 실패하면 마지막 정상 주소
            return synchronized(domainLock) { resolveDomain(prefs) }
        }

    // 접속에 성공한 주소를 기억하고, 막히면 tvwiki 번호 주소를 찾아 자동 연결
    override val client: OkHttpClient = network.client.newBuilder()
        .addInterceptor { chain -> domainIntercept(chain) }
        .build()

    // ================= 도메인 자동 찾기 =================
    private fun autoDomain(prefs: SharedPreferences?): Boolean =
        prefs?.getBoolean(PREF_AUTO_DOMAIN, true) ?: true

    private fun domainNumber(url: String): Int =
        NUMBER_REGEX.find(url)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    // 접속에 성공한 주소를 마지막 정상 주소로 저장
    private fun markGood(prefs: SharedPreferences?, url: String) {
        deadDomains.remove(url)
        if (lastGoodDomain(prefs) != url) {
            prefs?.edit()?.putString(PREF_LAST_GOOD_DOMAIN_KEY, url)?.apply()
        }
    }

    // 찾은 주소로 전환 (직접 지정한 주소가 있으면 그것도 바꾼다)
    private fun switchTo(prefs: SharedPreferences?, url: String) {
        markGood(prefs, url)
        if (customDomain(prefs) != null) prefs?.edit()?.putString(PREF_DOMAIN_KEY, url)?.apply()
        cachedDomain = url
        cacheValidUntil = System.currentTimeMillis() + CACHE_TTL_MS
    }

    // 접속 실패, 차단(403/451/5xx), 차단 안내 페이지로 넘어간 경우를 막힌 주소로 본다
    // (.php 요청의 403은 사이트가 요청만 거절한 것일 수 있어 제외)
    private fun isDead(res: Response): Boolean {
        if (!HOST_REGEX.matches(res.request.url.host)) return true
        if (res.code == 403) return !res.request.url.encodedPath.endsWith(".php")
        return res.code == 451 || res.code >= 500
    }

    private fun domainIntercept(chain: okhttp3.Interceptor.Chain): Response {
        val req = chain.request()
        val reqHost = req.url.host
        val prefs = getAppPreferences()
        if (!HOST_REGEX.matches(reqHost) || !autoDomain(prefs)) return chain.proceed(req)
        val reqBase = "https://$reqHost"

        fun retryOn(found: String): Response {
            switchTo(prefs, found)
            val host = found.toHttpUrlOrNull()!!.host
            return chain.proceed(req.newBuilder().url(req.url.newBuilder().host(host).build()).build())
        }

        val res = try {
            chain.proceed(req)
        } catch (e: java.io.IOException) {
            deadDomains.add(reqBase)
            val found = discoverDomain(reqBase) ?: throw e
            return retryOn(found)
        }

        if (req.method == "GET" && isDead(res)) {
            deadDomains.add(reqBase)
            val found = discoverDomain(reqBase) ?: return res
            res.close()
            return retryOn(found)
        }

        val finalHost = res.request.url.host
        val finalBase = "https://$finalHost"
        if (finalBase != reqBase && HOST_REGEX.matches(finalHost)) {
            // 사이트가 스스로 새 주소로 넘겨 준 경우
            switchTo(prefs, finalBase)
        } else if (res.isSuccessful) {
            markGood(prefs, reqBase)
        }
        return res
    }

    @Volatile private var lastDiscover = 0L

    // tvwiki 번호 주소를 현재 번호 -10 ~ +50 범위에서 동시에 열어 보고, 실제 티비위키인 가장 큰 번호를 고른다
    private fun discoverDomain(current: String): String? = synchronized(discoverLock) {
        val now = System.currentTimeMillis()
        if (now - lastDiscover < 60_000) return null
        lastDiscover = now

        val cur = domainNumber(current).takeIf { it > 0 } ?: domainNumber(DEFAULT_BASE_URL)
        val plain = OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(8, TimeUnit.SECONDS)
            .build()
        val pool = java.util.concurrent.Executors.newFixedThreadPool(20)
        try {
            val futures = ((cur - 10).coerceAtLeast(1)..(cur + 50))
                .map { "https://tvwiki$it.net" }
                .map { url ->
                    pool.submit<String?> {
                        try {
                            val r = Request.Builder().url("$url/").header("User-Agent", defaultUserAgent).build()
                            plain.newCall(r).execute().use { res ->
                                val fh = res.request.url.host
                                val ok = HOST_REGEX.matches(fh) && res.code == 200 &&
                                    res.peekBody(300_000).string().contains(SITE_MARKER)
                                if (ok) "https://$fh" else null
                            }
                        } catch (e: Exception) {
                            null
                        }
                    }
                }
            // 지금 주소가 가장 좋은 주소면 바꾸지 않음
            futures.mapNotNull { it.get() }.maxByOrNull { domainNumber(it) }?.takeIf { it != current }
        } finally {
            pool.shutdown()
        }
    }

    private val bridgeBaseUrl = "https://dc-toki-mangayomi-media.pages.dev"
    private val defaultUserAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
            "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", defaultUserAgent)
        .add("Referer", "$baseUrl/")

    // headers는 처음 한 번만 계산되므로, 주소가 바뀌어도 Referer가 맞도록 요청마다 새로 만든다
    private fun h(): Headers = headersBuilder().build()

    // ================= 목록 =================
    override fun popularAnimeRequest(page: Int): Request =
        GET("$baseUrl/popular?page=$page", h())

    override fun popularAnimeSelector(): String =
        "#list_type .box, #line_type .box, #mov_con_list .box, div.box, .slide_popular .box"

    override fun popularAnimeFromElement(element: Element): SAnime = SAnime.create().apply {
        val link = element.selectFirst("a.title2, a.title, a.img, a[href]")!!
        setUrlWithoutDomain(link.attr("href"))

        val titleNode = element.selectFirst("a.title2, a.title, .subject, .title")
        val imgNode = element.selectFirst("img")

        val rawTitle = titleNode?.attr("title")?.ifEmpty { null }
            ?: titleNode?.text()?.trim()?.ifEmpty { null }
            ?: imgNode?.attr("alt")?.trim()?.ifEmpty { null }
            ?: link.text().trim()

        // 목록 카드 제목은 연도 억지 주입 없이 순수 작품명으로 지정
        title = cleanSeriesTitle(rawTitle)

        thumbnail_url = imgNode?.let { img -> fixUrl(imageSrc(img)) }
    }

    override fun popularAnimeNextPageSelector(): String? =
        "a[rel='next'], .pg_next, .pagination .next, a:contains(다음)"

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = response.asJsoup()
        var elements = document.select(popularAnimeSelector())

        if (elements.isEmpty()) {
            elements = document.select("a[href~=^/(movie|kor_movie|drama|ent|ani|foreign_drama|docu)/\\d+$]")
        }

        val animeList = ArrayList<SAnime>()
        for (el in elements) {
            runCatching {
                val anime = popularAnimeFromElement(el)
                if (anime.url.isNotBlank() && !anime.url.contains("notice")) {
                    animeList.add(anime)
                }
            }
        }

        val uniqueList = animeList.distinctBy { it.url }
        val hasNextPage = popularAnimeNextPageSelector()?.let { document.selectFirst(it) } != null
        return AnimesPage(uniqueList, hasNextPage)
    }

    override fun latestUpdatesRequest(page: Int): Request =
        GET("$baseUrl/drama?page=$page", h())

    override fun latestUpdatesSelector(): String = popularAnimeSelector()
    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        if (query.isNotBlank()) {
            val encodedQuery = URLEncoder.encode(query, "UTF-8")
            return GET("$baseUrl/search?stx=$encodedQuery&sst=subIdx&page=$page", h())
        }

        var category = "all"
        var period = "d"
        var mode = "latest"

        filters.forEach { filter ->
            when (filter) {
                is CategoryFilter -> category = CATEGORIES[filter.state].second
                is PeriodFilter -> period = PERIODS[filter.state].second
                is ModeFilter -> mode = MODES[filter.state].second
                else -> {}
            }
        }

        val url = if (mode == "popular") {
            val catParam = if (category != "all") "&sb=$category" else ""
            "$baseUrl/popular?period=$period$catParam&page=$page"
        } else {
            val path = if (category == "all") "drama" else category
            "$baseUrl/$path?page=$page"
        }

        return GET(url, h())
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()
    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ================= 상세 / 에피소드 =================
    override fun animeDetailsRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())
    override fun episodeListRequest(anime: SAnime): Request = GET(baseUrl + anime.url, h())
    override fun videoListRequest(episode: SEpisode): Request = GET(baseUrl + episode.url, h())

    // og:title → 제목 노드 순으로 작품명을 찾고, 비어 있으면 fallback
    private fun pageTitleOf(document: Document, fallback: String): String {
        val og = document.selectFirst("meta[property='og:title']")?.attr("content")
        val node = document.selectFirst(TITLE_SELECTOR)?.text()
        return cleanSeriesTitle(og ?: node ?: "").ifEmpty { fallback }
    }

    private fun imageSrc(img: Element): String =
        img.attr("data-original").ifEmpty { img.attr("data-src").ifEmpty { img.attr("src") } }

    override fun animeDetailsParse(document: Document): SAnime = SAnime.create().apply {
        // 목록과 일치하는 순수 작품명 유지
        title = pageTitleOf(document, "티비위키")

        thumbnail_url = document.selectFirst(".poster img, .thumb img, img.cover, #bo_v_img img")
            ?.let { img -> fixUrl(imageSrc(img)) }

        val rawDesc = document.selectFirst(".thumb-desc, .desc, .summary, .content, #bo_v_con, p")?.text()?.trim()
        val releaseYear = YEAR_REGEX.find(document.text())?.groupValues?.get(1)

        // 연도 정보는 제목에 붙이지 않고 장르(Genre) 메타데이터로 배치
        if (!releaseYear.isNullOrEmpty()) {
            genre = "${releaseYear}년"
        }
        description = rawDesc
    }

    override fun episodeListSelector(): String =
        "#other_list li, ul.episode-list > li, div[class*='ep'] a, a"

    override fun episodeFromElement(element: Element): SEpisode = SEpisode.create().apply {
        val link = if (element.tagName() == "a") element else element.selectFirst("a")!!
        setUrlWithoutDomain(link.attr("href"))

        val rawText = link.text().trim().ifEmpty {
            link.attr("title").ifEmpty { element.text().trim() }
        }

        name = formatEpisodeName(rawText)
        episode_number = EP_REGEX.find(rawText)?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val currentPath = response.request.url.encodedPath.trimEnd('/')
        val episodes = ArrayList<SEpisode>()

        // 단일 에피소드(영화 등)일 때 사용할 작품 제목
        val pageTitle = pageTitleOf(document, "본편")

        val items = document.select("#other_list li")
        if (items.isNotEmpty()) {
            for (item in items) {
                val link = item.selectFirst("a.title.ep-link, a.title, a.ep-link, a[href]") ?: continue
                val href = link.attr("href")
                if (href.isNotBlank()) {
                    val fullItemText = item.text().trim()
                    episodes.add(
                        SEpisode.create().apply {
                            setUrlWithoutDomain(href)
                            name = formatEpisodeName(fullItemText, pageTitle)
                            episode_number = EP_REGEX.find(fullItemText)?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
                        },
                    )
                }
            }
        }

        if (episodes.isEmpty()) {
            val links = document.select("a[href]")
            for (link in links) {
                val href = link.attr("href")
                val text = link.text().trim()
                val isEpisodeUrl = href.startsWith(currentPath) && EP_URL_REGEX.matches(href) && href != currentPath
                val hasEpText = HAS_EP_TEXT_REGEX.matches(text)

                if (href.isNotBlank() && (isEpisodeUrl || hasEpText)) {
                    episodes.add(
                        SEpisode.create().apply {
                            setUrlWithoutDomain(href)
                            name = formatEpisodeName(text, pageTitle)
                            episode_number = EP_REGEX.find(text)?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
                        },
                    )
                }
            }
        }

        val uniqueList = episodes.distinctBy { it.url }

        // 에피소드가 1개인 경우(단편 영화 등) 줄거리 오류 텍스트를 작품 제목으로 치환
        if (uniqueList.size == 1) {
            val singleEp = uniqueList.first()
            if (singleEp.name.isBlank() || singleEp.name.contains("줄거리") || singleEp.name == "1화") {
                singleEp.name = pageTitle
            }
        }

        if (uniqueList.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    setUrlWithoutDomain(response.request.url.encodedPath)
                    name = pageTitle
                    episode_number = 1f
                },
            )
        }
        return uniqueList
    }

    // ================= 재생 =================
    override fun videoListParse(response: Response): List<Video> {
        val currentBaseUrl = baseUrl
        val episodePath = response.request.url.encodedPath
        val parts = episodePath.trim('/').split("/")
        if (parts.size < 3) {
            return fallbackVideoParse(response)
        }

        val boTable = parts[0]
        val wrId = parts[1]
        val epIdx = parts[2]

        val metaUrl = "$currentBaseUrl/bbs/get_episode.php?bo_table=$boTable&wr_id=$wrId&ep_idx=$epIdx"
        val metaHeaders = Headers.Builder()
            .add("User-Agent", defaultUserAgent)
            .add("Referer", "$currentBaseUrl$episodePath")
            .add("Accept", "application/json")
            .add("X-Requested-With", "XMLHttpRequest")
            .build()

        val metaResponse = client.newCall(GET(metaUrl, metaHeaders)).execute()
        val metaJson = JSONObject(metaResponse.body.string())
        if (!metaJson.optBoolean("success", false)) {
            return fallbackVideoParse(response)
        }

        val episodeObj = metaJson.getJSONObject("episode")
        val rawHlsUrl = episodeObj.optString("hls_url")
        val sessionDataList = listOfNotNull(episodeObj.opt("session_data1"), episodeObj.opt("session_data2"))

        var acquiredSession: JSONObject? = null
        for (payload in sessionDataList) {
            val payloadStr = payload.toString()

            // 1순위: 티비위키 원본 서버에 세션 직접 생성
            runCatching {
                val directHeaders = Headers.Builder()
                    .add("User-Agent", defaultUserAgent)
                    .add("Referer", "$currentBaseUrl$episodePath")
                    .add("Origin", currentBaseUrl)
                    .add("Content-Type", "application/json; charset=utf-8")
                    .build()
                val reqBody = payloadStr.toRequestBody("application/json; charset=utf-8".toMediaType())
                val directRes = client.newCall(POST("$currentBaseUrl/api/create_session.php", directHeaders, reqBody)).execute()
                val resJson = JSONObject(directRes.body.string())
                if (resJson.optBoolean("success", false) && resJson.has("player_url")) {
                    acquiredSession = resJson
                }
            }
            if (acquiredSession != null) break

            // 2순위: 원본 실패 시 중계 브릿지로 백업 세션 생성
            runCatching {
                val bridgeReqObj = JSONObject().apply {
                    put("baseUrl", currentBaseUrl)
                    put("episodePath", episodePath)
                    put("sessionData", if (payloadStr.startsWith("{")) JSONObject(payloadStr) else payloadStr)
                }
                val bridgeHeaders = Headers.Builder()
                    .add("User-Agent", defaultUserAgent)
                    .add("Referer", "$bridgeBaseUrl/")
                    .add("Content-Type", "application/json; charset=utf-8")
                    .build()
                val reqBody = bridgeReqObj.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                val bridgeRes = client.newCall(POST("$bridgeBaseUrl/api/tvwiki-session", bridgeHeaders, reqBody)).execute()
                val resJson = JSONObject(bridgeRes.body.string())
                if (resJson.optBoolean("success", false) && resJson.has("player_url")) {
                    acquiredSession = resJson
                }
            }
            if (acquiredSession != null) break
        }

        val sessionJson = acquiredSession ?: return fallbackVideoParse(response)

        val rawPlayerUrl = sessionJson.getString("player_url")
        val sep = if (rawPlayerUrl.contains("?")) "&" else "?"
        val playerUrl = resolveAbsolute("$currentBaseUrl$episodePath", rawPlayerUrl) +
            "${sep}t=${URLEncoder.encode(sessionJson.optString("t"), "UTF-8")}&sig=${URLEncoder.encode(sessionJson.optString("sig"), "UTF-8")}"

        val playlistUrl = resolveAbsolute(playerUrl, rawHlsUrl)

        val playerOrigin = runCatching {
            val u = playerUrl.toHttpUrlOrNull()
            "${u?.scheme}://${u?.host}"
        }.getOrDefault(currentBaseUrl)

        val streamHeaders = Headers.Builder()
            .add("User-Agent", defaultUserAgent)
            .add("Accept", "*/*")
            .add("Referer", playerUrl)
            .add("Origin", playerOrigin)
            .build()

        val playlistRes = client.newCall(GET(playlistUrl, streamHeaders)).execute()
        val playlistContent = playlistRes.body.string()

        val keyMatch = KEY_REGEX.find(playlistContent)
        val videoList = ArrayList<Video>()

        if (keyMatch != null) {
            val keyUrl = resolveAbsolute(playlistUrl, keyMatch.groupValues[1])
            val envelopeRes = client.newCall(GET(keyUrl, streamHeaders)).execute()
            val envelope = envelopeRes.body.string()

            val uParam = URLEncoder.encode(toBase64Url(playlistUrl), "UTF-8")
            val rParam = URLEncoder.encode(toBase64Url(playerUrl), "UTF-8")
            val xParam = URLEncoder.encode(toBase64Url(envelope), "UTF-8")
            val common = "u=$uParam&r=$rParam&x=$xParam"

            // 1순위: CDN 직접 스트리밍 (복호화 키 정상 포함)
            videoList.add(
                Video(
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common",
                    "빠른 재생 (CDN 직접)",
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common",
                    headers = streamHeaders,
                ),
            )
            // 2순위: 중계 프록시 재생
            videoList.add(
                Video(
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common",
                    "호환 재생 (중계)",
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common",
                    headers = streamHeaders,
                ),
            )
        } else {
            videoList.add(Video(playlistUrl, "자동 (HLS)", playlistUrl, headers = streamHeaders))
        }

        return if (videoList.isNotEmpty()) videoList else fallbackVideoParse(response)
    }

    private fun fallbackVideoParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val list = ArrayList<Video>()
        document.select("video source, video").forEach { v ->
            val src = v.attr("src")
            if (src.isNotBlank()) list.add(Video(fixUrl(src), "직접 재생", fixUrl(src)))
        }
        return list
    }

    // ================= 유틸 =================
    private fun toBase64Url(value: String): String {
        return Base64.encodeToString(
            value.toByteArray(Charsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        ).trim()
    }

    private fun resolveAbsolute(base: String, target: String): String {
        val t = target.trim()
        if (t.startsWith("http://") || t.startsWith("https://")) return t
        if (t.startsWith("//")) return "https:$t"
        return if (t.startsWith("/")) {
            val baseUri = base.toHttpUrlOrNull()
            "${baseUri?.scheme}://${baseUri?.host}$t"
        } else {
            val dir = base.substringBeforeLast('/')
            "$dir/$t"
        }
    }

    private fun fixUrl(url: String): String = when {
        url.startsWith("//") -> "https:$url"
        url.startsWith("/") -> "$baseUrl$url"
        else -> url
    }

    private fun cleanSeriesTitle(raw: String): String =
        raw.replace(TITLE_EP_SUFFIX_REGEX, "")
            .replace(TITLE_REPLAY_SUFFIX_REGEX, "")
            .trim()

    private fun formatEpisodeName(raw: String, fallbackTitle: String = "본편"): String {
        var trimmed = raw.trim()

        // '등록된 줄거리가 없습니다' 문구 및 불필요한 줄거리 안내 텍스트 필터링
        if (trimmed.contains("줄거리가 없습니다") || trimmed.contains("등록된 줄거리")) {
            trimmed = trimmed.replace(NO_PLOT_REGEX, "").trim()
        }

        // 1. 회차 추출 (예: 820화, 820회)
        val epText = EP_REGEX.find(trimmed)?.let { "${it.groupValues[1]}화" } ?: ""

        // 2. 방영 날짜 추출 (예: 2026-09-13)
        val dateText = DATE_REGEX.find(trimmed)?.groupValues?.get(1)

        // 3. 부제 추출 (회차와 날짜를 제거하고 남은 텍스트)
        val subTitle = trimmed
            .replace(SUBTITLE_PREFIX_REGEX, "")
            .replace(DATE_REGEX, "")
            .replace(LEADING_SEPARATOR_REGEX, "")
            .trim()

        val formatted = buildString {
            if (epText.isNotBlank()) append(epText)
            if (!dateText.isNullOrBlank()) {
                if (isNotEmpty()) append(" - ")
                append(dateText)
            }
            if (subTitle.isNotBlank()) {
                if (isNotEmpty()) append(" ")
                append(subTitle)
            }
        }.trim()

        // 줄거리가 없어서 공백이 되었거나 단편 영화일 경우 작품 제목으로 대체
        return if (formatted.isBlank()) fallbackTitle else formatted
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException()
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException()
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException()

    override fun getFilterList(): AnimeFilterList = AnimeFilterList(
        CategoryFilter(CATEGORIES),
        PeriodFilter(PERIODS),
        ModeFilter(MODES),
    )

    // ================= 설정 화면 =================
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        fun summaryOf(current: String) =
            "빈 값이면 중앙신호등의 최신 주소를 사용하고, 실패하면 마지막 정상 주소로 복구합니다.\n현재 주소: $current"

        val domainPref = EditTextPreference(screen.context).apply {
            key = PREF_DOMAIN_KEY
            title = "티비위키 주소 직접 지정 (선택)"
            // 메인 스레드에서 네트워크를 부르지 않도록 캐시 기반 주소를 표시
            summary = summaryOf(currentDomainNoNetwork())
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "tvwiki숫자.net 형식의 HTTPS 주소만 허용됩니다."
            setDefaultValue("")

            setOnPreferenceChangeListener { _, newValue ->
                val newUrl = (newValue as String).trim().trimEnd('/')
                val prefs = getAppPreferences()
                when {
                    newUrl.isBlank() -> {
                        prefs?.edit()?.remove(PREF_DOMAIN_KEY)?.apply()
                        cachedDomain = null
                        cacheValidUntil = 0L
                        summary = summaryOf(currentDomainNoNetwork())
                        Toast.makeText(screen.context, "중앙신호등 모드로 전환되었습니다.", Toast.LENGTH_SHORT).show()
                        true
                    }
                    DOMAIN_REGEX.matches(newUrl) -> {
                        prefs?.edit()?.putString(PREF_DOMAIN_KEY, newUrl)?.apply()
                        summary = summaryOf(newUrl)
                        Toast.makeText(screen.context, "주소가 변경되었습니다: $newUrl", Toast.LENGTH_SHORT).show()
                        true
                    }
                    else -> {
                        Toast.makeText(screen.context, "올바른 주소 형식이 아닙니다 (예: https://tvwiki51.net)", Toast.LENGTH_LONG).show()
                        false
                    }
                }
            }
        }
        screen.addPreference(domainPref)

        androidx.preference.SwitchPreferenceCompat(screen.context).apply {
            key = PREF_AUTO_DOMAIN
            title = "도메인 자동 찾기"
            summary = "중앙신호등 주소로도 접속이 안 되면 tvwiki 번호 주소(현재 번호 -10 ~ +50)를 찾아 자동 변경합니다. " +
                "신호등이 접속에 성공했던 주소보다 낮은 번호를 알려 주면 성공했던 주소를 계속 씁니다."
            setDefaultValue(true)
        }.also(screen::addPreference)
    }

    class CategoryFilter(categories: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("카테고리", categories.map { it.first }.toTypedArray())

    class PeriodFilter(periods: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("기간 (인기탭)", periods.map { it.first }.toTypedArray())

    class ModeFilter(modes: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("정렬 방식", modes.map { it.first }.toTypedArray())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val PREF_LAST_GOOD_DOMAIN_KEY = "pref_last_good_domain"
        private const val PREF_AUTO_DOMAIN = "pref_auto_domain"
        private const val DEFAULT_BASE_URL = "https://tvwiki51.net"

        private const val SIGNAL_URL = "https://aniyomi-extensions.pages.dev/api/signal"

        private const val CACHE_TTL_MS = 10 * 60 * 1000L
        private const val RETRY_TTL_MS = 60 * 1000L

        @Volatile private var cachedDomain: String? = null
        @Volatile private var cacheValidUntil: Long = 0L
        private val domainLock = Any()
        private val discoverLock = Any()

        // 이번 실행 중 접속이 안 된 주소 (신호등이 다시 알려 줘도 쓰지 않음)
        private val deadDomains: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

        private val DOMAIN_REGEX = Regex("""^https://tvwiki\d+\.net$""")
        private val HOST_REGEX = Regex("""^tvwiki\d+\.net$""")
        private val NUMBER_REGEX = Regex("""tvwiki(\d+)\.net""")
        private const val SITE_MARKER = "티비위키"

        private const val TITLE_SELECTOR = "#bo_v_title .bo_v_tit, #bo_v_title h1, h1, .view-title"

        // 반복 사용되는 정규식은 한 번만 만들어 재사용
        private val EP_REGEX = Regex("""(\d+(?:[-.]\d+)?)\s*[화회]""")
        private val DATE_REGEX = Regex("""(\d{4}[.-]\d{2}[.-]\d{2})""")
        private val YEAR_REGEX = Regex("""개봉년도\s*:\s*(\d{4})""")
        private val EP_URL_REGEX = Regex(".*/\\d+$")
        private val HAS_EP_TEXT_REGEX = Regex(""".*\d+\s*[화회].*""")
        private val NO_PLOT_REGEX = Regex("""등록된\s*줄거리가\s*없습니다\.?""")
        private val SUBTITLE_PREFIX_REGEX = Regex("""^.*?(\d+(?:[-.]\d+)?\s*[화회])""")
        private val LEADING_SEPARATOR_REGEX = Regex("""^\s*[-:–]\s*""")
        private val TITLE_EP_SUFFIX_REGEX = Regex("""\s+\d+(?:[-.]\d+)?화(?:\s+다시보기)?\s*$""")
        private val TITLE_REPLAY_SUFFIX_REGEX = Regex("""\s+다시보기(?:\s*-\s*티비위키)?\s*$""")
        private val KEY_REGEX = Regex("""#EXT-X-KEY:[^\r\n]*URI="([^"]+)"""", RegexOption.IGNORE_CASE)

        private val CATEGORIES = arrayOf(
            Pair("전체", "all"),
            Pair("영화", "movie"),
            Pair("한국영화", "kor_movie"),
            Pair("드라마", "drama"),
            Pair("예능프로그램", "ent"),
            Pair("시사·다큐", "sisa"),
            Pair("해외드라마", "world"),
            Pair("해외 예능·다큐", "ott_ent"),
            Pair("숏폼 드라마", "short_drama"),
            Pair("극장판 애니", "ani_movie"),
            Pair("일반 애니", "animation"),
            Pair("추억의 예능", "old_ent"),
            Pair("추억의 드라마", "old_drama"),
        )

        private val PERIODS = arrayOf(
            Pair("일간", "d"),
            Pair("주간", "w"),
            Pair("월간", "m"),
            Pair("전체 기간", "a"),
        )

        private val MODES = arrayOf(
            Pair("최신순", "latest"),
            Pair("인기순", "popular"),
        )
    }
                                      }
