package eu.kanade.tachiyomi.animeextension.ko.livesports

import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

class LiveSports : AnimeHttpSource() {

    override val name = "실시간스포츠"

    override val baseUrl = "https://livesports.example.com"

    override val lang = "ko"

    override val supportsLatest = false

    override val client: OkHttpClient = network.client

    // ================= 인기 목록 (Popular) =================
    override fun popularAnimeRequest(page: Int): Request {
        return GET("$baseUrl/")
    }

    override fun popularAnimeParse(response: Response): AnimesPage {
        val animeList = mutableListOf<SAnime>()
        return AnimesPage(animeList, false)
    }

    // ================= 최신 목록 (Latest) =================
    override fun latestUpdatesRequest(page: Int): Request {
        return popularAnimeRequest(page)
    }

    override fun latestUpdatesParse(response: Response): AnimesPage {
        return popularAnimeParse(response)
    }

    // ================= 검색 (Search) =================
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        return GET("$baseUrl/?s=$query")
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val animeList = mutableListOf<SAnime>()
        return AnimesPage(animeList, false)
    }

    // ================= 상세 정보 (Details) =================
    override fun animeDetailsParse(response: Response): SAnime {
        val anime = SAnime.create()
        anime.title = "실시간스포츠 채널"
        anime.status = SAnime.COMPLETED
        return anime
    }

    // ================= 에피소드 / 방송 목록 (Episode List) =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episodeList = mutableListOf<SEpisode>()
        return episodeList
    }

    // ================= 비디오 스트림 주소 (Video Stream) =================
    override fun videoListParse(response: Response): List<Video> {
        return emptyList()
    }

    override fun videoUrlParse(response: Response): String {
        return ""
    }
}
