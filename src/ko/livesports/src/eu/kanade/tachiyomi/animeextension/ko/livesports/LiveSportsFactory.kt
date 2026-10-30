package eu.kanade.tachiyomi.animeextension.ko.livesports

import eu.kanade.tachiyomi.animeextension.ko.livesports1.LiveSports1
import eu.kanade.tachiyomi.animeextension.ko.livesports2.LiveSports2
import eu.kanade.tachiyomi.animeextension.ko.samsungtvplus.SamsungTvPlus
import eu.kanade.tachiyomi.animesource.AnimeSource
import eu.kanade.tachiyomi.animesource.AnimeSourceFactory

class LiveSportsFactory : AnimeSourceFactory {
    override fun createSources(): List<AnimeSource> = listOf(
        // 실시간스포츠(njtv, LiveSports.kt)는 2026-10-30 배포 중단 — 코드는 기록으로 남겨 둠
        LiveSports1(), // 실시간스포츠1 (굿라이브티비 gltv88.com)
        LiveSports2(), // 실시간스포츠2 (tongtv.net)
        SamsungTvPlus(), // 삼성 TV 플러스 (삼성 공식 무료 실시간 채널)
    ) + SamsungTvPlus.SOURCE_GROUPS.map { SamsungTvPlus(it) } // 삼성 TV 플러스 · 분류별 (설정은 기본 소스와 같이 씀)
}
