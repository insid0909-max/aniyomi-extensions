package eu.kanade.tachiyomi.animeextension.ko.livesports

import eu.kanade.tachiyomi.animeextension.ko.livesports2.LiveSports2
import eu.kanade.tachiyomi.animeextension.ko.livetv.LiveTv
import eu.kanade.tachiyomi.animesource.AnimeSource
import eu.kanade.tachiyomi.animesource.AnimeSourceFactory

class LiveSportsFactory : AnimeSourceFactory {
    override fun createSources(): List<AnimeSource> = listOf(
        LiveSports(), // 실시간스포츠 (njtv-01.com)
        LiveSports2(), // 실시간스포츠2 (tongtv.net)
        LiveTv(), // 라이브TV (방송사 공식 무료 실시간 채널)
    )
}
