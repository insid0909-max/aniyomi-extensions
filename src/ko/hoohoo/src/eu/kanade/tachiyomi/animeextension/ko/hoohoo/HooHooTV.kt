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
        "a[href*='/detail/']:has(img), div.item:has(a[href*='/detail/']), div.post-item:has(a[href*='/detail/'])"

    override fun popularAnimeFromElement(element: Element): SAnime {
        return SAnime.create().apply {
            val anchor = if (element.tagName() == "a") element else element.selectFirst("a[href*='/detail/']") ?: element
            setUrlWithoutDomain(anchor.attr("href"))

            val img = element.selectFirst("img")
            val extractedTitle = img?.attr("alt")?.takeIf { it.isNotBlank() }
                ?: img?.attr("title")?.takeIf { it.isNotBlank() }
                ?: anchor.attr("title").takeIf { it.isNotBlank() }
                ?: element.selectFirst(".title, .subject, .name")?.text()?.takeIf { it.isNotBlank() }
                ?: "제목 없음"

            title = cleanTitle(extractedTitle)

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
            val hElements = document.select("h1, h2, h3, .title, .subject")
            val detailTitle = hElements
                .map { it.text().trim() }
                .firstOrNull { it.isNotBlank() && !it.contains("다시보기") && !it.contains("후후티비") && !it.contains("영화 ,") }
                ?: document.title()

            title = cleanTitle(detailTitle)

            description = document.select(".desc, .summary, div:contains(줄거리) + div, div:contains(줄거리) + p, .content").text().trim()

            val img = document.selectFirst(".poster img, .detail-thumb img, img.thumb")
            thumbnail_url = img?.let {
                it.attr("abs:data-src").ifEmpty {
                    it.attr("abs:data-original").ifEmpty {
                        it.attr("abs:src")
                    }
                }
            }
        }
    }

    // --- 회차 목록 파싱 (본문 내 모든 회차 링크 수집) ---
    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val episodes = mutableListOf<SEpisode>()

        // 1. 본문 안의 모든 링크 중에서 회차 정보를 담고 있는 태그 수집
        val linkElements = document.select("a[href*='/detail/'], a[href*='/view/'], a[href*='/watch/'], a[href*='/play/'], .ep-item a, .episode-list a")
        for (el in linkElements) {
            val href = el.attr("href")
            val text = el.text().trim()
            // 회차 식별 조건 (화, 회, 시즌, 또는 날짜 형식 포함)
            if (href.isNotBlank() && (text.contains("화") || text.contains("회") || text.contains("시즌"))) {
                val cleanedName = cleanEpisodeName(text)
                episodes.add(
                    SEpisode.create().apply {
                        name = cleanedName
                        setUrlWithoutDomain(href)
                    },
                )
            }
        }

        // 2. 만약 별도 회차 링크 태그가 없다면 본문 텍스트 내 현재 에피소드 1개 생성
        if (episodes.isEmpty()) {
            val currentTitle = document.select("h1, h2, h3, .title")
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

    // --- 비디오 재생 링크 (Iframe 내부 실제 스트림 추출) ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()

        // 1. 직접 비디오 태그
        val directVideos = document.select("video source[src], video[src]")
        for (v in directVideos) {
            val src = v.attr("abs:src")
            if (src.isNotBlank() && (src.contains(".m3u8") || src.contains(".mp4"))) {
                videoList.add(Video(src, "직접 재생", src, headers = headers))
            }
        }

        // 2. iframe 탐색 -> iframe 내부 HTML 재요청하여 실제 m3u8/mp4 추출
        val iframes = document.select("iframe[src], iframe[data-src]")
        for (iframe in iframes) {
            val iframeUrl = iframe.attr("abs:src").ifEmpty { iframe.attr("abs:data-src") }
            if (iframeUrl.isBlank() || iframeUrl.contains("google") || iframeUrl.contains("ad")) continue

            try {
                val iframeHeaders = headers.newBuilder().set("Referer", document.location()).build()
                val iframeDoc = client.newCall(GET(iframeUrl, iframeHeaders)).execute().asJsoup()
                val iframeHtml = iframeDoc.html()

                // 내부 video 태그 탐색
                val innerSrc = iframeDoc.selectFirst("video source[src], video[src]")?.attr("abs:src")
                if (!innerSrc.isNullOrBlank()) {
                    videoList.add(Video(innerSrc, "고화질 스트림 (내부)", innerSrc, headers = iframeHeaders))
                }

                // 스크립트 내부 스트림 주소 정규식 추출
                """https?://[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*""".toRegex().findAll(iframeHtml).forEach { match ->
                    val streamUrl = match.value
                    val label = if (streamUrl.contains("m3u8")) "HLS 스트림" else "MP4 비디오"
                    videoList.add(Video(streamUrl, label, streamUrl, headers = iframeHeaders))
                }
            } catch (_: Exception) {
                // iframe 직접 요청 실패 시 fallback 등록
                videoList.add(Video(iframeUrl, "플레이어 링크", iframeUrl, headers = headers))
            }
        }

        // 3. 본문 스크립트 내부 스트림 주소 탐색
        val html = document.html()
        """https?://[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*""".toRegex().findAll(html).forEach { match ->
            val streamUrl = match.value
            val label = if (streamUrl.contains("m3u8")) "HLS 스트림" else "MP4 비디오"
            videoList.add(Video(streamUrl, label, streamUrl, headers = headers))
        }

        return videoList.distinctBy { it.url }
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")

    // 불필요한 조회수 및 태그 정리
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
