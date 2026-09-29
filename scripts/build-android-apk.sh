#!/usr/bin/env bash
# Build the Clutch Android APK. One entry point for both callers — the release
# CI (release.yml android-apk), the debug CI (android-debug.yml) and a local
# `bash scripts/build-android-apk.sh ...` — so CI stays a thin shell around it.
#
#   usage: build-android-apk.sh <pylibs-index-url> <version> <out.apk>
#
#   <pylibs-index-url>  N3 stamp: where the phone downloads pylibs from. The
#                       release CI passes the tag's own release asset URL;
#                       android-debug.yml passes its `pylibs_index_url` input.
#   <version>           becomes versionName (gradle -PAPP_VERSION), e.g. the
#                       tag `v1.2.3` or a debug build id.
#   <out.apk>           where to put the finished APK.
#
# The product is a DEBUG APK, signed with the machine's auto-generated debug
# keystore — installable and WebView-debuggable (chrome://inspect), which is
# what M3 acceptance needs; release signing (upload keystore + secrets) is a
# deliberate later step, and each build's signature differs until then.
# Prerequisites on the build machine: JDK 17, Android SDK with
#   platforms;android-34  build-tools;34.0.0  ndk;26.3.11579264  cmake;3.22.1
# (the workflows install exactly that list; `sdkmanager --install "..."`).
# Run from anywhere:  scripts/build-android-apk.sh <url> <version> <out.apk>
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 3 ]; then
  echo "usage: build-android-apk.sh <pylibs-index-url> <version> <out.apk>" >&2
  exit 2
fi
INDEX_URL=$1
VERSION=$2
OUT=$3

: "${INDEX_URL:?pylibs-index-url must not be empty}"
: "${VERSION:?version must not be empty}"
: "${OUT:?out apk path must not be empty}"

command -v java >/dev/null || {
  echo "build-android-apk: no java on PATH — this build needs a JDK 17 (set JAVA_HOME)" >&2
  exit 1
}

# 1. stamp the N3 contract BEFORE syncing: sync-android-host.sh copies the
#    stamped file into assets/nodejs-project, where artifact-provider-android
#    resolves it via __dirname on the phone.
mkdir -p android/host
printf '%s\n' "$INDEX_URL" > android/host/pylibs-index-url.txt

# 2. engine + render layer (idempotent; libnode zip is cached in android/.cache)
bash scripts/fetch-android-libnode.sh
bash scripts/sync-android-host.sh

# 3. gradle: --no-daemon keeps CI memory flat and leaves no stray JVM behind
( cd android && ./gradlew --no-daemon :app:assembleDebug -PAPP_VERSION="$VERSION" )

# 4. ship the artifact out of the build tree
BUILT=android/app/build/outputs/apk/debug/app-debug.apk
[ -f "$BUILT" ] || { echo "build-android-apk: gradle produced no $BUILT" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
cp "$BUILT" "$OUT"

echo "build-android-apk: wrote $OUT (versionName $VERSION, index $INDEX_URL)"
sha256sum "$OUT"
