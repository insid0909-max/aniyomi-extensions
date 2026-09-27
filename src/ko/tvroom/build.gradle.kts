plugins {
    id("com.android.application")
    id("kotlin-android")
}

ext {
    set("extName", "TVroom")
    set("extClass", ".TVroom")
    set("extVersionCode", 1)
}

apply(from = "$rootDir/common.gradle")

repositories {
    mavenCentral()
    google()
    maven { url = uri("https://jitpack.io") }
}

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.tvroom"
}

dependencies {
    implementation(project(":core"))
}
