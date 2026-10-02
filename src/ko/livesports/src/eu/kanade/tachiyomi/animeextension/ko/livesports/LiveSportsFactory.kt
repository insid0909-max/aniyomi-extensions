package eu.kanade.tachiyomi.animeextension.ko.livesports

import eu.kanade.tachiyomi.animeextension.ko.livesports2.LiveSports2
import eu.kanade.tachiyomi.animesource.AnimeSource
import eu.kanade.tachiyomi.animesource.AnimeSourceFactory

class LiveSportsFactory : AnimeSourceFactory {
    override fun createSources(): List<AnimeSource> = listOf(
        LiveSports(), // 실시간스포츠 (njtv-01.com)
        LiveSports2(), // 실시간스포츠2 (tongtv.net)
    )
}
