package io.github.insid0909.statusboard

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject

/** 앱 화면 = 웹 상태판(GitHub Pages) 그대로 + 주소 복사 + 알림 권한 + 새 버전 안내 */
class MainActivity : Activity() {
    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(), "StatusApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url.toString()
                if (u.startsWith(Status.PAGE)) return false
                // 사이트 주소 등은 휴대폰 브라우저로
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                // 웹뷰는 클립보드 쓰기가 막힐 수 있어 앱이 대신 복사
                view.evaluateJavascript(
                    "try{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(t){StatusApp.copy(String(t));return Promise.resolve();}}});}catch(e){}",
                    null,
                )
            }
        }
        web.loadUrl(Status.PAGE)

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        Status.schedule(this)
        Thread { runCatching { Status.refresh(applicationContext) } }.start()
        checkUpdate()
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) web.reload()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    inner class Bridge {
        @JavascriptInterface
        fun copy(text: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("주소", text))
                Toast.makeText(this@MainActivity, "복사했어요: $text", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /** 저장소의 version.json 과 비교해 새 버전이 있으면 받기 안내 (하루 한 번) */
    private fun checkUpdate() {
        val p = getSharedPreferences("status", Context.MODE_PRIVATE)
        if (System.currentTimeMillis() - p.getLong("ver_at", 0) < 6 * 3600_000L) return
        Thread {
            try {
                val j = JSONObject(Status.get(Status.VERSION_URL)).optJSONObject(getString(R.string.channel_tag)) ?: return@Thread
                p.edit().putLong("ver_at", System.currentTimeMillis()).apply()
                val latest = j.optInt("versionCode")
                @Suppress("DEPRECATION")
                val mine = packageManager.getPackageInfo(packageName, 0).versionCode
                if (latest > mine) {
                    val url = j.optString("url")
                    runOnUiThread {
                        if (isFinishing) return@runOnUiThread
                        AlertDialog.Builder(this)
                            .setTitle("새 버전 ${j.optString("versionName")} 있어요")
                            .setMessage("지금 버전 ${packageManager.getPackageInfo(packageName, 0).versionName}\n받은 APK 를 열어 설치하면 위젯·설정은 그대로예요.")
                            .setPositiveButton("받기") { _, _ -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                            .setNegativeButton("나중에", null)
                            .show()
                    }
                }
            } catch (e: Exception) {
                // 다음에 다시
            }
        }.start()
    }
}
