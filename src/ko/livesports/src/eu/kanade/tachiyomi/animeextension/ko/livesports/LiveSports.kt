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

    override val isNsfw = false

    override val supportsLatest = false

    override val client: OkHttpClient = network.client

    // ================= Ninki (Popular) =================
    override fun popularAnimeRequest(page: Int): Request {
        return GET("$baseUrl/")
    }

    override fun popularAnimeParse(response: Response): AnimesPage {
        val animeList = mutableListOf<SAnime>()
        return AnimesPage(animeList, false)
    }

    // ================= Saishin (Latest) =================
    override fun latestUpdatesRequest(page: Int): Request {
        return popularAnimeRequest(page)
    }

    override fun latestUpdatesParse(response: Response): AnimesPage {
        return popularAnimeParse(response)
    }

    // ================= Kensaku (Search) =================
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        return GET("$baseUrl/?s=$query")
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val animeList = mutableListOf<SAnime>()
        return AnimesPage(animeList, false)
    }

    // ================= Shousai (Details) =================
    override fun animeDetailsParse(response: Response): SAnime {
        val anime = SAnime.create()
        anime.title = "실시간스포츠 채널"
        anime.status = SAnime.COMPLETED
        return anime
    }

    // ================= Episode Ichiran =================
    override fun episodeListParse(response: Response): List<SEpisode> {
        val episodeList = mutableListOf<SEpisode>()
        return episodeList
    }

    // ================= Douga Stream URL =================
    override fun videoListParse(response: Response): List<Video> {
        return emptyList()
    }

    override fun videoUrlParse(response: Response): String {
        return ""
    }
}
