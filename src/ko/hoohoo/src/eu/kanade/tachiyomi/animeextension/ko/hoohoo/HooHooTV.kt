package eu.kanade.tachiyomi.animeextension.ko.hoohoo

import android.util.Base64
import android.webkit.CookieManager
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.ParsedAnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.net.URLEncoder

class HooHooTV : ParsedAnimeHttpSource() {

    override val name = "후후티비"

    override val lang = "ko"

    override val supportsLatest = true

    override val client: OkHttpClient = network.cloudflareClient

    override val baseUrl = "https://fu.hoohootv458.xyz"

    override fun headersBuilder(): Headers.Builder {
        val cookie = runCatching { CookieManager.getInstance().getCookie(baseUrl) }.getOrNull() ?: ""
        return Headers.Builder()
            .add("User-Agent", "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36")
            .add("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
            .add("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
            .add("Sec-Ch-Ua", "\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\", \"Not-A.Brand\";v=\"99\"")
            .add("Sec-Ch-Ua-Mobile", "?1")
            .add("Sec-Ch-Ua-Platform", "\"Android\"")
            .add("Sec-Fetch-Dest", "document")
            .add("Sec-Fetch-Mode", "navigate")
            .add("Sec-Fetch-Site", "same-origin")
            .add("Sec-Fetch-User", "?1")
            .add("Upgrade-Insecure-Requests", "1")
            .add("Referer", "$baseUrl/")
            .apply {
                if (cookie.isNotBlank()) {
                    add("Cookie", cookie)
                }
            }
    }

    // --- 인기 탭 ---
    override fun popularAnimeRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/popular" else "$baseUrl/popular?page=$page"
        return GET(url, headers)
    }

    override fun popularAnimeSelector(): String =
        "#container div[class*='item']:has(a[href*='/detail/']), #container div[class*='post']:has(a[href*='/detail/']), #container div[class*='col']:has(a[href*='/detail/'])"

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = response.asJsoup()
        val animeList = mutableListOf<SAnime>()

        val elements = document.select(popularAnimeSelector())
        for (element in elements) {
            val anime = popularAnimeFromElement(element)
            if (anime.url.isNotBlank()) {
                animeList.add(anime)
            }
        }

        val hasNextPage = popularAnimeNextPageSelector()?.let { document.selectFirst(it) } != null
        return AnimesPage(animeList.distinctBy { it.url }, hasNextPage)
    }

    override fun popularAnimeFromElement(element: Element): SAnime {
        return SAnime.create().apply {
            val anchor = element.selectFirst("a[href*='/detail/']") ?: element
            setUrlWithoutDomain(anchor.attr("href"))

            val img = element.selectFirst("img")
            val rawTitle = img?.attr("alt")?.takeIf { it.isNotBlank() }
                ?: img?.attr("title")?.takeIf { it.isNotBlank() }
                ?: anchor.attr("title").takeIf { it.isNotBlank() }
                ?: element.selectFirst(".title, .subject, .name")?.text()?.takeIf { it.isNotBlank() }
                ?: anchor.text().takeIf { it.isNotBlank() }
                ?: "제목 없음"

            title = cleanTitle(rawTitle)

            thumbnail_url = img?.let {
                it.attr("abs:data-src").ifEmpty {
                    it.attr("abs:data-original").ifEmpty {
                        it.attr("abs:data-lazy-src").ifEmpty {
                            it.attr("abs:src")
                        }
                    }
                }
            }
        }
    }

    override fun popularAnimeNextPageSelector(): String? = ".pagination .next, a.next, .nav-links .next, a[rel='next']"

    // --- 최신 탭 ---
    override fun latestUpdatesRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/home" else "$baseUrl/home?page=$page"
        return GET(url, headers)
    }

    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)
    override fun latestUpdatesSelector(): String = popularAnimeSelector()
    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 검색 (웹뷰 캡처 기반 실제 주소: /search?sfl=common&stx=) ---
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val encodedQuery = URLEncoder.encode(query, "UTF-8")
        val url = if (page <= 1) {
            "$baseUrl/search?sfl=common&stx=$encodedQuery"
        } else {
            "$baseUrl/search?sfl=common&stx=$encodedQuery&page=$page"
        }
        return GET(url, headers)
    }

    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)
    override fun searchAnimeSelector(): String = popularAnimeSelector()
    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 상세 정보 ---
    override fun animeDetailsParse(document: Document): SAnime {
        return SAnime.create().apply {
            val container = document.selectFirst("#container") ?: document
            val detailTitle = container.select("h1, h2, h3, .title, [class*='title']")
                .map { it.text().trim() }
                .firstOrNull { it.isNotBlank() && !it.contains("다시보기") && !it.contains("후후티비") && !it.contains("영화 ,") }
                ?: document.title()

            title = cleanTitle(detailTitle)

            val fullDesc = container.select(".desc, .summary, div:contains(줄거리) + div, div:contains(줄거리) + p, .content").text().trim()
            description = cleanDescription(fullDesc)

            val img = container.selectFirst(".poster img, .detail-thumb img, img.thumb")
            thumbnail_url = img?.let {
                it.attr("abs:data-src").ifEmpty {
                    it.attr("abs:data-original").ifEmpty {
                        it.attr("abs:src")
                    }
                }
            }
        }
    }

    // --- 회차 목록 파싱 (이전화, 다음화 및 전체 회차 링크 완벽 수집) ---
    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val episodes = mutableListOf<SEpisode>()

        // 1. 모든 링크 태그 조사
        val linkElements = document.select("#container a[href*='/detail/'], a[href*='/detail/']")
        for (el in linkElements) {
            val href = el.attr("href")
            val text = el.text().trim()
            if (href.isNotBlank() && (text.contains("화") || text.contains("회") || text.contains("시즌"))) {
                episodes.add(
                    SEpisode.create().apply {
                        name = cleanEpisodeName(text)
                        setUrlWithoutDomain(href)
                    },
                )
            }
        }

        // 2. 만약 별도 링크가 모달/비동기라 잡히지 않았다면 현재 회차 등록
        if (episodes.isEmpty()) {
            val currentTitle = document.select("#container h1, #container h2, #container h3, [class*='title']")
                .map { it.text().trim() }
                .firstOrNull { it.contains("화") || it.contains("회") }
                ?: "현재 회차 바로보기"

            episodes.add(
                SEpisode.create().apply {
                    name = cleanEpisodeName(currentTitle)
                    setUrlWithoutDomain(response.request.url.encodedPath)
                },
            )
        }

        return episodes.distinctBy { it.url }
    }

    override fun episodeListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun episodeFromElement(element: Element): SEpisode = throw UnsupportedOperationException("Not used")

    // --- 비디오 재생 링크 (JW Player / creatorofvideo 완벽 대응) ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()
        val currentUrl = response.request.url.toString()
        val pageHtml = document.html()

        // 1. 현재 상세 페이지 본문에서 스트림 추출
        extractStreamsFromHtml(pageHtml, currentUrl, videoList)

        // 2. iframe 내부 탐색 (creatorofvideo.com 호스트 진입)
        val iframes = document.select("iframe[src], iframe[data-src]")
        for (iframe in iframes) {
            val iframeUrl = iframe.attr("abs:src").ifEmpty { iframe.attr("abs:data-src") }
            if (iframeUrl.isBlank() || iframeUrl.contains("google") || iframeUrl.contains("ad")) continue

            try {
                val iframeHeaders = headers.newBuilder()
                    .set("Referer", currentUrl)
                    .build()

                val iframeDoc = client.newCall(GET(iframeUrl, iframeHeaders)).execute().asJsoup()
                val iframeHtml = iframeDoc.html()

                extractStreamsFromHtml(iframeHtml, iframeUrl, videoList)
            } catch (_: Exception) {
            }
        }

        return videoList.distinctBy { it.url }
    }

    // JWPlayer, HLS, MP4 정밀 추출 헬퍼
    private fun extractStreamsFromHtml(html: String, refererUrl: String, list: MutableList<Video>) {
        val reqHeaders = headers.newBuilder().set("Referer", refererUrl).build()

        // 패턴 A: sources: [{file: "https://..."}] 또는 file: "https://..."
        val fileRegex = """["']?(?:file|source|src)["']?\s*:\s*["'](https?://[^"']+)["']""".toRegex(RegexOption.IGNORE_CASE)
        fileRegex.findAll(html).forEach { match ->
            val url = match.groupValues[1]
            if (url.contains(".m3u8") || url.contains(".mp4") || url.contains("/play") || url.contains("creatorofvideo")) {
                val label = if (url.contains(".m3u8")) "HLS 고화질 스트림" else "MP4 비디오"
                list.add(Video(url, label, url, headers = reqHeaders))
            }
        }

        // 패턴 B: 본문 속 직접 m3u8 주소
        val directM3u8Regex = """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex()
        directM3u8Regex.findAll(html).forEach { match ->
            list.add(Video(match.value, "HLS 마스터 스트림", match.value, headers = reqHeaders))
        }

        // 패턴 C: Base64 인코딩된 스트림 주소 탐색 (플레이어가 aHR0c... 로 숨겨둔 경우)
        val base64Regex = """aHR0c[A-Za-z0-9+/=]{20,}""".toRegex()
        base64Regex.findAll(html).forEach { match ->
            try {
                val decoded = String(Base64.decode(match.value, Base64.DEFAULT))
                if (decoded.startsWith("http") && (decoded.contains(".m3u8") || decoded.contains(".mp4"))) {
                    list.add(Video(decoded, "디코딩 스트림", decoded, headers = reqHeaders))
                }
            } catch (_: Exception) {
            }
        }
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")

    private fun cleanTitle(raw: String): String {
        return raw.replace(Regex("""(?i)다시보기|후후티비.*|영화\s*,.*|\b\d{1,3}(,\d{3})+\b|드라마\s*,.*|미스터리.*|코미디.*"""), "")
            .trim()
            .ifEmpty { raw.trim() }
    }

    private fun cleanDescription(raw: String): String {
        val cutoffIndex = raw.indexOf("시즌")
        return if (cutoffIndex != -1) {
            raw.substring(0, cutoffIndex).trim()
        } else {
            raw
        }
    }

    private fun cleanEpisodeName(raw: String): String {
        return raw.replace(Regex("""(?i)영화\s*,.*|다시보기|후후티비.*|\b\d{1,3}(,\d{3})+\b|드라마\s*,.*|미스터리.*"""), "")
            .trim()
            .ifEmpty { "회차 바로보기" }
    }
}
