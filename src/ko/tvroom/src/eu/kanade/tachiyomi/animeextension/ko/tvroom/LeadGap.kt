package eu.kanade.tachiyomi.animeextension.ko.tvroom

import eu.kanade.tachiyomi.animesource.model.SEpisode

/**
 * 2026-11-15: 사이트가 오래된 회차를 지운 긴 방송(티비위키 아침마당: 9045화부터 1216개)은 애니요미가 1화부터 세어
 * "Missing 9044" 처럼 보임 → 가장 작은 회차 번호가 10보다 크면 모든 번호를 같은 만큼 당겨 가장 오래된 회차가 1이 되게.
 * 회차 이름("9045화 (11.13)")은 그대로, 중간에 빠진 회차는 그대로 Missing 으로 보임. 망가요미는 있는 회차 중 가장 작은 번호부터 세어 해당 없음
 */
internal object LeadGap {
    fun shift(eps: List<SEpisode>): List<SEpisode> {
        val nums = eps.map { it.episode_number }.filter { it > 0f }
        val min = nums.minOrNull() ?: return eps
        if (min <= 10f) return eps
        val by = kotlin.math.floor(min) - 1f
        eps.forEach { if (it.episode_number > 0f) it.episode_number = Math.round((it.episode_number - by) * 100f) / 100f }
        return eps
    }
}
