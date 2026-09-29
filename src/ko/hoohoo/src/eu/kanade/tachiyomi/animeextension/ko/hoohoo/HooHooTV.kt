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
            
            // 1. img의 alt/title 속성이나 부모 anchor의 title을 최우선으로 가져와 '제목 없음' 해결
            val extractedTitle = img?.attr("alt")?.takeIf { it.isNotBlank() }
                ?: img?.attr("title")?.takeIf { it.isNotBlank() }
                ?: anchor.attr("title").takeIf { it.isNotBlank() }
                ?: element.selectFirst(".title, .subject, .name, h2, h3")?.text()?.takeIf { it.isNotBlank() }
                ?: anchor.text().takeIf { it.isNotBlank() }
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

    // --- 상세 정보 (웹뷰 캡처 구조 정확 타겟팅) ---
    override fun animeDetailsParse(document: Document): SAnime {
        return SAnime.create().apply {
            // 웹뷰 스크린샷 기준: '영화, 드라마...' 사이트 배너는 배제하고 본문의 실제 회차/작품 타이틀 추출
            val detailTitle = document.select("h1, h2, h3, div[class*='title']")
                .map { it.text().trim() }
                .firstOrNull { it.isNotBlank() && !it.contains("다시보기") && !it.contains("후후티비") && !it.contains("영화 ,") }
                ?: document.title()

            title = cleanTitle(detailTitle)

            // 줄거리 영역 추출
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

    // --- 회차 목록 (기본 1회차 보장 및 다중 회차 추출) ---
    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val episodes = mutableListOf<SEpisode>()

        // 1. 페이지 내 회차 버튼이나 링크가 있는 경우 추출
        val epElements = document.select("a[href*='/detail/'], a[href*='/view/'], a[href*='/watch/'], .episode-list a, .ep-item a")
        for (el in epElements) {
            val href = el.attr("href")
            val epName = el.text().trim()
            if (href.isNotBlank() && epName.isNotBlank() && (epName.contains("화") || epName.contains("회") || epName.contains("시즌"))) {
                episodes.add(
                    SEpisode.create().apply {
                        name = epName
                        setUrlWithoutDomain(href)
                    },
                )
            }
        }

        // 2. 만약 상세 페이지 자체가 단일 재생 회차라 별도 리스트 태그가 없다면, 현재 페이지를 '1화(현재 회차)'로 등록
        if (episodes.isEmpty()) {
            val epTitle = document.select("h1, h2, h3, div[class*='title']")
                .map { it.text().trim() }
                .firstOrNull { it.contains("화") || it.contains("회") }
                ?: "1화 (바로보기)"

            episodes.add(
                SEpisode.create().apply {
                    name = epTitle
                    setUrlWithoutDomain(response.request.url.encodedPath)
                },
            )
        }

        return episodes.distinctBy { it.url }
    }

    override fun episodeListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun episodeFromElement(element: Element): SEpisode = throw UnsupportedOperationException("Not used")

    // --- 비디오 재생 링크 (웹뷰의 실제 플레이어 영역 추출) ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()

        // 1. iframe 추출
        val iframes = document.select("iframe[src], iframe[data-src]")
        for (iframe in iframes) {
            val src = iframe.attr("abs:src").ifEmpty { iframe.attr("abs:data-src") }
            if (src.isNotBlank() && !src.contains("google") && !src.contains("ad")) {
                videoList.add(Video(src, "기본 재생 플레이어", src, headers = headers))
            }
        }

        // 2. HTML5 direct video 태그
        val directVideos = document.select("video source[src], video[src]")
        for (v in directVideos) {
            val src = v.attr("abs:src")
            if (src.isNotBlank()) {
                videoList.add(Video(src, "직접 재생", src, headers = headers))
            }
        }

        // 3. 페이지 스크립트 내부 스트림 주소(m3u8, mp4)
        val html = document.html()
        """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex().findAll(html).forEach {
            videoList.add(Video(it.value, "고화질 스트림 (m3u8)", it.value, headers = headers))
        }
        """https?://[^\s"'<>]+\.mp4[^\s"'<>]*""".toRegex().findAll(html).forEach {
            videoList.add(Video(it.value, "MP4 직접 재생", it.value, headers = headers))
        }

        return videoList
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")

    private fun cleanTitle(raw: String): String {
        return raw.replace(Regex("(?i)다시보기|후후티비.*|영화\\s*,.*"), "").trim().ifEmpty { raw.trim() }
    }
}
