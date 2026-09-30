plugins {
    id("com.android.application")
    id("kotlin-android")
}

val extCode = 1

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
            res.srcDirs("res")
        }
    }
}

configurations.all {
    exclude(group = "com.github.inorichi.injekt")
}
