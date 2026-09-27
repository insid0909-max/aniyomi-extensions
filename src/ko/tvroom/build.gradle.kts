plugins {
    id("com.android.application")
    id("kotlin-android")
}

ext {
    set("appName", "Aniyomi: Movie")
    set("extClass", ".TVroom")
    set("extVersionCode", 1)
    set("libVersion", "14")
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.tvroom"
}

dependencies {
    implementation(project(":core"))
}
