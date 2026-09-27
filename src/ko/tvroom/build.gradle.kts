plugins {
    id("com.android.application")
    id("kotlin-android")
}

ext {
    set("extName", "영화")
    set("extClass", ".TVroom")
    set("extVersionCode", 1)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.tvroom"
}

dependencies {
    implementation(project(":core"))
}
