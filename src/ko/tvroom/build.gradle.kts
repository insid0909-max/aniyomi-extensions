plugins {
    id("com.android.application")
    id("kotlin-android")
}

val extVer = if (project.hasProperty("extVersionCode")) {
    project.property("extVersionCode").toString().toInt()
} else {
    6
}

ext {
    set("extName", "TVroom")
    set("extClass", ".TVroom")
    set("extVersionCode", extVer)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.tvroom"

    sourceSets {
        getByName("main") {
            res.srcDirs("res")
        }
    }
}

configurations.all {
    exclude(group = "com.github.inorichi.injekt")
}
