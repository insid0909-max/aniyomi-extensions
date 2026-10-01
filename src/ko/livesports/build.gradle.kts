plugins {
    id("com.android.application")
    id("kotlin-android")
}

// CI의 sed 명령어로 주입되는 고정 버전 코드
val extCode = 8751

ext {
    set("extName", "LiveSports")
    set("extClass", ".LiveSports")
    set("extVersionCode", extCode)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.livesports"

    sourceSets {
        getByName("main") {
            manifest.srcFile("AndroidManifest.xml")
            res.srcDirs("res")
        }
    }
}

configurations.all {
    exclude(group = "com.github.inorichi.injekt")
}
