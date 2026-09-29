package eu.kanade.tachiyomi.animeextension.ko.hoohoo

import android.webkit.CookieManager
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
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
        "#container a[href*='/detail/']:has(img), #container div[class*='item']:has(a[href*='/detail/']), #container div[class*='post']:has(a[href*='/detail/'])"

    override fun popularAnimeFromElement(element: Element): SAnime {
        return SAnime.create().apply {
            val anchor = if (element.tagName() == "a") element else element.selectFirst("a[href*='/detail/']") ?: element
            setUrlWithoutDomain(anchor.attr("href"))

            val img = element.selectFirst("img")
            val rawTitle = img?.attr("alt")?.takeIf { it.isNotBlank() }
                ?: img?.attr("title")?.takeIf { it.isNotBlank() }
                ?: anchor.attr("title").takeIf { it.isNotBlank() }
                ?: element.selectFirst(".title, .subject, .name")?.text()?.takeIf { it.isNotBlank() }
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

    override fun latestUpdatesSelector(): String = popularAnimeSelector()

    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 검색 ---
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val encodedQuery = URLEncoder.encode(query, "UTF-8")
        val url = if (page <= 1) {
            "$baseUrl/?s=$encodedQuery"
        } else {
            "$baseUrl/page/$page/?s=$encodedQuery"
        }
        return GET(url, headers)
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()

    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 상세 정보 ---
    override fun animeDetailsParse(document: Document): SAnime {
        return SAnime.create().apply {
            // #container 내부 본문 영역에서 제목 정밀 탐색 (#header 오염 차단)
            val container = document.selectFirst("#container") ?: document
            val detailTitle = container.select("h1, h2, h3, .title, .subject, [class*='title']")
                .map { it.text().trim() }
                .firstOrNull { it.isNotBlank() && !it.contains("다시보기") && !it.contains("후후티비") && !it.contains("영화 ,") }
                ?: document.title()

            title = cleanTitle(detailTitle)

            description = container.select(".desc, .summary, div:contains(줄거리) + div, div:contains(줄거리) + p, .content").text().trim()

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

    // --- 회차 목록 (캡처된 모든 링크 수집) ---
    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val episodes = mutableListOf<SEpisode>()

        // 1. #container 내부의 모든 상세/재생 링크 수집
        val linkElements = document.select("#container a[href*='/detail/'], #container a[href*='/view/'], #container a[href*='/watch/'], a[href*='/detail/']")
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

        // 2. 단일 페이지(또는 리스트가 비동기인 경우) 현재 페이지 회차 보장
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

    // --- 비디오 재생 링크 (JW Player 및 creatorofvideo 스트림 정밀 파싱) ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()
        val pageHtml = document.html()

        // 1. 본문 스크립트 내 jwplayer setup 또는 file: "..." 직접 추출
        extractStreamsFromHtml(pageHtml, document.location(), videoList)

        // 2. iframe 및 외부 플레이어 페이지(creatorofvideo.com 등) 진입 파싱
        val iframes = document.select("iframe[src], iframe[data-src]")
        for (iframe in iframes) {
            val iframeUrl = iframe.attr("abs:src").ifEmpty { iframe.attr("abs:data-src") }
            if (iframeUrl.isBlank() || iframeUrl.contains("google") || iframeUrl.contains("ad")) continue

            try {
                val iframeHeaders = headers.newBuilder().set("Referer", document.location()).build()
                val iframeDoc = client.newCall(GET(iframeUrl, iframeHeaders)).execute().asJsoup()
                val iframeHtml = iframeDoc.html()

                // 내부 HTML에서 m3u8 / mp4 추출
                extractStreamsFromHtml(iframeHtml, iframeUrl, videoList)
            } catch (_: Exception) {
                // 실패 시 스킵
            }
        }

        return videoList.distinctBy { it.url }
    }

    // m3u8 및 mp4 추출 공통 헬퍼
    private fun extractStreamsFromHtml(html: String, refererUrl: String, list: MutableList<Video>) {
        val reqHeaders = headers.newBuilder().set("Referer", refererUrl).build()

        // jwplayer file: "..." 패턴
        val fileRegex = """(?:file|source)\s*:\s*["'](https?://[^"']+\.(?:m3u8|mp4)[^"']*)["']""".toRegex(RegexOption.IGNORE_CASE)
        fileRegex.findAll(html).forEach { match ->
            val streamUrl = match.groupValues[1]
            val label = if (streamUrl.contains(".m3u8")) "JW HLS 스트림" else "JW MP4 비디오"
            list.add(Video(streamUrl, label, streamUrl, headers = reqHeaders))
        }

        // 전체 본문 url 정규식
        val directStreamRegex = """https?://[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*""".toRegex()
        directStreamRegex.findAll(html).forEach { match ->
            val streamUrl = match.value
            val label = if (streamUrl.contains(".m3u8")) "HLS 고화질 스트림" else "MP4 고화질"
            list.add(Video(streamUrl, label, streamUrl, headers = reqHeaders))
        }
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")

    private fun cleanTitle(raw: String): String {
        return raw.replace(Regex("""(?i)다시보기|후후티비.*|영화\s*,.*|\b\d{1,3}(,\d{3})+\b|드라마\s*,.*"""), "")
            .trim()
            .ifEmpty { raw.trim() }
    }

    private fun cleanEpisodeName(raw: String): String {
        return raw.replace(Regex("""(?i)영화\s*,.*|다시보기|후후티비.*"""), "")
            .trim()
            .ifEmpty { "회차 바로보기" }
    }
}
