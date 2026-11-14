package io.github.insid0909.statusboard

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView

/** 위젯 설정 — 투명도·글자 크기·배경색. 위젯을 놓을 때·위젯 ⚙·길게 눌러 설정(안드로이드 12+)에서 열림. 바꾸면 바로 위젯에 반영. */
class WidgetSettings : Activity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        // 위젯을 놓다가 뒤로 가도 위젯은 기본 모양으로 놓이게
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))

        val dp = resources.displayMetrics.density
        val pad = (20 * dp).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun label(t: String, big: Boolean = false) = TextView(this).apply {
            text = t
            textSize = if (big) 22f else 16f
            if (big) setTypeface(typeface, Typeface.BOLD)
            setPadding(0, (if (big) 0 else 22 * dp).toInt(), 0, (8 * dp).toInt())
        }
        box.addView(label("위젯 설정", true))

        var transparency = Status.transparency(this)
        var scale = Status.scaleIndex(this)
        var bg = Status.bgMode(this)
        fun apply() {
            Status.saveStyle(this, transparency, scale, bg)
            Status.redraw(this)
        }

        val tLabel = label("배경 투명도 $transparency%")
        box.addView(tLabel)
        box.addView(TextView(this).apply { text = "0% = 배경 그대로 · 100% = 배경 없이 글자만"; textSize = 13f; alpha = 0.7f })
        box.addView(
            SeekBar(this).apply {
                max = 100
                progress = transparency
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(sb: SeekBar, p: Int, user: Boolean) {
                        transparency = p
                        tLabel.text = "배경 투명도 $p%"
                        apply()
                    }

                    override fun onStartTrackingTouch(sb: SeekBar) {}
                    override fun onStopTrackingTouch(sb: SeekBar) {}
                })
            },
        )

        fun group(title: String, names: Array<String>, sel: Int, onPick: (Int) -> Unit) {
            box.addView(label(title))
            val g = RadioGroup(this)
            names.forEachIndexed { i, n ->
                g.addView(RadioButton(this).apply { id = 1000 + i; text = n; textSize = 15f })
            }
            g.check(1000 + sel)
            g.setOnCheckedChangeListener { _, id -> onPick(id - 1000) }
            box.addView(g)
        }
        group("글자 크기", Status.SCALE_NAMES, scale) { scale = it; apply() }
        group("배경색", Status.BG_NAMES, bg) { bg = it; apply() }

        box.addView(
            TextView(this).apply {
                text = "위젯 칸 크기는 홈 화면에서 위젯을 길게 누른 뒤 테두리를 끌어 바꿔요."
                textSize = 13f
                alpha = 0.7f
                setPadding(0, (22 * dp).toInt(), 0, 0)
            },
        )
        box.addView(
            Button(this).apply {
                text = "완료"
                setOnClickListener {
                    apply()
                    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
                    finish()
                }
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (24 * dp).toInt()
                gravity = Gravity.CENTER_HORIZONTAL
            },
        )
        setContentView(ScrollView(this).apply { addView(box) })
        // 위젯을 막 놓았으면 자료를 바로 받아 그림
        Thread { runCatching { Status.refresh(applicationContext) } }.start()
    }
}
