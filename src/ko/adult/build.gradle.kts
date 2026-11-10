plugins {
    id("com.android.application")
    id("kotlin-android")
}

// CI의 sed 명령어로 주입되는 고정 버전 코드
val extCode = 8930

ext {
    set("extName", "Adult")
    set("extClass", ".AdultFactory")
    set("extVersionCode", extCode)
    set("isNsfw", true)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.adult"

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
