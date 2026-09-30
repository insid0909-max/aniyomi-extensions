plugins {
    id("com.android.application")
    id("kotlin-android")
}

val extCode = if (project.hasProperty("extVersionCode")) {
    project.property("extVersionCode").toString().toInt()
} else {
    4390
}

ext {
    set("extName", "TVroom")
    set("extClass", ".TVroom")
    set("extVersionCode", extCode)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.tvroom"

    sourceSets {
        getByName("main") {
            res.srcDirs("res")
        }
    }
}

configurations.all {
    exclude(group = "com.github.inorichi.injekt")
}

// common.gradle이 끝난 후 최종 평가 단계에서 versionCode와 versionName을 강제 주입
project.afterEvaluate {
    android.defaultConfig.versionCode = extCode
    android.defaultConfig.versionName = "14.$extCode"
}
