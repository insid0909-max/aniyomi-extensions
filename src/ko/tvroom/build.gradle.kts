name: CI

on:
  push:
    branches:
      - master
  workflow_dispatch:

jobs:
  build:
    name: Build Extensions
    runs-on: ubuntu-latest
    steps:
      - name: Checkout master branch
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up JDK 17
        uses: actions/setup-java@v4
        with:
          java-version: 17
          distribution: temurin

      - name: Set up Gradle
        uses: gradle/actions/setup-gradle@v3

      - name: Prepare signing key
        run: |
          keytool -genkey -v -keystore "$GITHUB_WORKSPACE/signingkey.jks" -alias aniyomi -keyalg RSA -keysize 2048 -validity 10000 -storepass password -keypass password -dname "CN=aniyomi, OU=aniyomi, O=aniyomi, L=Unknown, S=Unknown, C=Unknown"
          cp "$GITHUB_WORKSPACE/signingkey.jks" src/ko/tvroom/signingkey.jks || true
          
          # 서명 지문 추출
          SIGNING_KEY=$(keytool -list -v -keystore "$GITHUB_WORKSPACE/signingkey.jks" -alias aniyomi -storepass password | grep "SHA256:" | awk '{print $2}' | tr -d ':' | tr '[:upper:]' '[:lower:]')
          echo "SIGNING_KEY=$SIGNING_KEY" >> $GITHUB_ENV
          echo "Extracted SHA-256 Fingerprint: $SIGNING_KEY"

      - name: Build extensions
        env:
          CI_CHUNK_NUM: 0
          CI_CHUNK_SIZE: 1
          CI_SIGNING_KEY: signingkey.jks
          CI_SIGNING_KEY_ALIAS: aniyomi
          CI_SIGNING_KEY_PASSWORD: password
          CI_SIGNING_STORE_PASSWORD: password
          SIGNING_STORE_PASSWORD: password
          SIGNING_KEY_PASSWORD: password
          SIGNING_KEY_ALIAS: aniyomi
        run: |
          ./gradlew :src:ko:tvroom:assembleRelease \
            -PsigningStorePassword=password \
            -PsigningKeyPassword=password \
            -PsigningKeyAlias=aniyomi \
            -PsigningStoreFile="$GITHUB_WORKSPACE/signingkey.jks" \
            -Pandroid.injected.signing.store.file="$GITHUB_WORKSPACE/signingkey.jks" \
            -Pandroid.injected.signing.store.password=password \
            -Pandroid.injected.signing.key.alias=aniyomi \
            -Pandroid.injected.signing.key.password=password \
            --stacktrace

      - name: Prepare repo and index
        run: |
          mkdir -p repo/anime
          find . -name "*.apk" -type f ! -path "./repo/*" -exec cp -v {} repo/ \;
          find . -name "*.apk" -type f ! -path "./repo/*" -exec cp -v {} repo/anime/ \;
          ls -la repo/

          cat << 'EOF' > generate_index.py
          import os, shutil, json

          repo_dir = "repo"
          signing_key = os.environ.get("SIGNING_KEY", "")

          # 실제 빌드된 APK 파일명 탐색
          apk_files = [f for f in os.listdir(repo_dir) if f.endswith(".apk")]
          orig_apk = apk_files[0] if apk_files else "aniyomi-ko.tvroom-v14.11-release.apk"
          
          # 표준 네이밍으로 복사 배포
          target_apk = "aniyomi-ko.tvroom-v14.11-release.apk"
          shutil.copy2(os.path.join(repo_dir, orig_apk), os.path.join(repo_dir, target_apk))
          shutil.copy2(os.path.join(repo_dir, orig_apk), os.path.join(repo_dir, "anime", target_apk))

          # 1. repo.json
          repo_data = {
              "meta": {
                  "name": "TVroom Repository",
                  "shortName": "TVroom",
                  "website": "https://github.com/insid0909-max/aniyomi-extensions",
                  "signingKeyFingerprint": signing_key
              }
          }
          with open(os.path.join(repo_dir, "repo.json"), "w", encoding="utf-8") as fp:
              json.dump(repo_data, fp, ensure_ascii=False, indent=2)
          with open(os.path.join(repo_dir, "anime", "repo.json"), "w", encoding="utf-8") as fp:
              json.dump(repo_data, fp, ensure_ascii=False, indent=2)

          # 2. DC Toki와 1:1 완벽 정합 인덱스 (code 11 -> version 14.11, id 정수형)
          extensions = [{
              "name": "Aniyomi: TVroom",
              "pkg": "eu.kanade.tachiyomi.animeextension.ko.tvroom",
              "apk": target_apk,
              "lang": "ko",
              "code": 11,
              "version": "14.11",
              "nsfw": 0,
              "sources": [
                  {
                      "name": "TVroom",
                      "lang": "ko",
                      "id": 2135778533207260895,
                      "baseUrl": "https://tvwiki51.net",
                      "versionId": 1
                  }
              ]
          }]

          # 루트 및 anime 양쪽에 json 배포
          for p in [os.path.join(repo_dir, "index.min.json"), os.path.join(repo_dir, "anime", "index.min.json")]:
              with open(p, "w", encoding="utf-8") as fp:
                  json.dump(extensions, fp, ensure_ascii=False, separators=(',', ':'))

          print("Generated clean repo.json and index.min.json")
          EOF

          python3 generate_index.py
          cat repo/index.min.json

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./repo
          publish_branch: gh-pages
