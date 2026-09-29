plugins {
    id("com.android.application")
    id("kotlin-android")
}

ext {
    set("extName", "티비위키")
    set("extClass", ".TVroom")
    set("extVersionCode", 250)
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

dependencies {
    implementation(project(":core")) {
        exclude(group = "com.github.inorichi.injekt")
    }
}
