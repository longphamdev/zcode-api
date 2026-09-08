package com.zcode.proxy

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** GitHub Release 元数据（https://github.com/TriDefender/zcode-api/releases）。 */
data class UpdateInfo(
    val tag: String,
    val htmlUrl: String,
    val apkUrl: String?,
    val notes: String?,
)

object UpdateChecker {
    private const val TAG = "UpdateChecker"
    private const val LATEST_API = "https://api.github.com/repos/TriDefender/zcode-api/releases/latest"
    const val RELEASES_PAGE = "https://github.com/TriDefender/zcode-api/releases"
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000

    /** 静默失败：GitHub 不可达/限流/响应异常一律返回 null，绝不影响启动流程。 */
    suspend fun fetchLatest(): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val conn = URL(LATEST_API).openConnection() as HttpURLConnection
            try {
                conn.connectTimeout = CONNECT_TIMEOUT_MS
                conn.readTimeout = READ_TIMEOUT_MS
                conn.setRequestProperty("Accept", "application/vnd.github+json")
                // GitHub API 拒绝无 User-Agent 的请求（403）
                conn.setRequestProperty("User-Agent", "ZCodeProxy-Android")
                if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                    Log.w(TAG, "releases/latest HTTP ${conn.responseCode}")
                    null
                } else {
                    parse(conn.inputStream.bufferedReader().use { it.readText() })
                }
            } finally {
                conn.disconnect()
            }
        } catch (t: Throwable) {
            Log.i(TAG, "update check failed: ${t.message}")
            null
        }
    }

    private fun parse(text: String): UpdateInfo? = try {
        val json = JSONObject(text)
        val tag = json.optString("tag_name")
        if (tag.isBlank()) {
            null
        } else {
            UpdateInfo(
                tag = tag,
                htmlUrl = json.optString("html_url", RELEASES_PAGE).ifBlank { RELEASES_PAGE },
                apkUrl = json.optJSONArray("assets")?.let { arr ->
                    (0 until arr.length())
                        .map { arr.getJSONObject(it) }
                        .filter { it.optString("name").endsWith(".apk", ignoreCase = true) }
                        // 优先签名 release 包，其次 debug 包
                        .sortedBy { if (it.optString("name").contains("release", ignoreCase = true)) 0 else 1 }
                        .firstOrNull()
                        ?.optString("browser_download_url")
                        ?.ifBlank { null }
                },
                notes = json.optString("body").ifBlank { null },
            )
        }
    } catch (t: Throwable) {
        Log.w(TAG, "failed to parse release payload: ${t.message}")
        null
    }

    /**
     * 提取前三个数字段逐位比较。current 取自 APK versionName：release CI 直接写入
     * 完整 tag（如 "v5.0.0"），本地/开发构建是 "<package.json 版本>-android"
     * （build.gradle.kts 从仓库 package.json 派生，release CI 会自动 bump 并提交），
     * 因此只有当正式 release 比仓库版本更新时才提示。/releases/latest 不返回
     * prerelease，故无需处理 alpha/beta/rc 后缀。
     */
    fun isNewer(current: String?, latestTag: String): Boolean {
        if (current.isNullOrBlank()) return true
        val cur = numericParts(current)
        val lat = numericParts(latestTag)
        if (lat.isEmpty()) return false
        val n = maxOf(cur.size, lat.size, 3)
        for (i in 0 until n) {
            val c = cur.getOrElse(i) { 0 }
            val l = lat.getOrElse(i) { 0 }
            if (c != l) return l > c
        }
        return false
    }

    private fun numericParts(v: String): List<Int> =
        Regex("\\d+").findAll(v).take(3).mapNotNull { it.value.toIntOrNull() }.toList()
}

/** 更新偏好持久化：「忽略此版本」的 tag 不再自动弹窗；自动检查开关（默认开）控制启动时是否查询。手动检查均不受影响。 */
object UpdatePrefs {
    private const val PREFS = "update_prefs"
    private const val KEY_SKIPPED_TAG = "skipped_tag"
    private const val KEY_AUTO_CHECK = "auto_check"

    fun loadSkipped(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SKIPPED_TAG, null)

    fun saveSkipped(context: Context, tag: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SKIPPED_TAG, tag)
            .apply()
    }

    fun loadAutoCheck(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_AUTO_CHECK, true)

    fun saveAutoCheck(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_AUTO_CHECK, enabled)
            .apply()
    }
}
