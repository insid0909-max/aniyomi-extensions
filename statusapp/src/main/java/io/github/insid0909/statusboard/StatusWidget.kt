package io.github.insid0909.statusboard

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context

/** 홈 화면 위젯 — 30분마다(안드로이드 최소 간격) 새로 받음, ↻ 누르면 바로, 나머지 칸을 누르면 앱 열기 */
class StatusWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        val pending = goAsync()
        Thread {
            try {
                Status.refresh(ctx)
            } finally {
                pending.finish()
            }
        }.start()
    }

    override fun onEnabled(ctx: Context) {
        Status.schedule(ctx)
    }
}
