plugins {
    id("com.android.application")
    kotlin("android")
}

ext {
    set("extName", "LiveSports")
    set("pkgNameSuffix", null)
    set("extClass", ".LiveSports")
    set("extVersionCode", 1)
}

apply(from = "$rootDir/common.gradle")
