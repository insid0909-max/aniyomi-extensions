plugins {
    id("com.android.application")
    id("kotlin-android")
}

ext {
    set("extName", "HooHooTV")
    set("extClass", ".HooHooTV")
    set("extVersionCode", 1)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.hoohoo"

    sourceSets {
        getByName("main") {
            // tvroom의 TV 아이콘 리소스를 그대로 공유
            res.srcDirs("$rootDir/src/ko/tvroom/res")
        }
    }
}

configurations.all {
    exclude(group = "com.github.inorichi.injekt")
}

dependencies {
    implementation(project(":core")) {
        exclude(group = "com.github.inorichi.injekt")
    }
}

