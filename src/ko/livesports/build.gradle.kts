ext {
    set("extName", "LiveSports")
    set("extClass", ".LiveSports")
    set("extVersionCode", 1)
}

dependencies {
    implementation("com.github.inorichi.injekt:injekt-core:fa53f28")
}

apply(from = "$rootDir/common.gradle")
