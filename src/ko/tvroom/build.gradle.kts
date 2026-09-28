plugins {
    id("com.android.application")
    id("kotlin-android")
}

ext {
    set("extName", "티비위키")
    set("pkgNameSuffix", "ko.tvroom")
    set("extClass", ".TVroom")
    set("extVersionCode", 11)
    set("libVersion", "14")
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.tvroom"
    defaultConfig {
        versionCode = 11
        versionName = "14.2"
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
