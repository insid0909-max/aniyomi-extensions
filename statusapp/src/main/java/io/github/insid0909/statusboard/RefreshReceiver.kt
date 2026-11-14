package io.github.insid0909.statusboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 30분 알람·위젯 ↻·휴대폰 켜짐·앱 업데이트 때 새로 받기 */
class RefreshReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Status.ACTION_REFRESH) Status.schedule(ctx)
        val pending = goAsync()
        Thread {
            try {
                Status.refresh(ctx)
            } finally {
                pending.finish()
            }
        }.start()
    }
}
