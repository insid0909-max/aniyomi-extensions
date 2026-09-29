plugins {
    id("com.android.application")
    id("kotlin-android")
}

ext {
    set("extName", "HooHoo")
    set("extClass", ".HooHooTV")
    set("extVersionCode", 150)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.hoohoo"

    sourceSets {
        getByName("main") {
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
