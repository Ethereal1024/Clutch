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
# The product is a DEBUG APK signed with the PROJECT key (android/keystore,
# see android/app/build.gradle signingConfigs): debug-flavoured so the WebView
# stays debuggable (chrome://inspect), and signed with one certificate forever so
# each release installs over the previous one. The finished artifact's signer is
# checked against android/keystore/cert-sha256.txt before this script returns.
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

# 5. The signature is a CONTRACT, not an accident. Android installs an APK over
#    the previous one only when the certificate matches, and the failure appears
#    on somebody's phone — never here. So read the certificate out of the
#    finished file and compare it with the digest pinned in the repo: a build
#    signed by anything else (a leftover machine-local debug key, a wrong
#    -P keystore) fails HERE, in the build that produced it.
if [ "${SKIP_SIGNATURE_CHECK:-}" = "1" ]; then
  echo "build-android-apk: signature check SKIPPED (SKIP_SIGNATURE_CHECK=1)"
  exit 0
fi
PIN=android/keystore/cert-sha256.txt
[ -f "$PIN" ] || { echo "build-android-apk: no $PIN to check against" >&2; exit 1; }
EXPECT=$(tr -d '[:space:]' < "$PIN")

# Which apksigner? A machine can have several build-tools installed, and the
# newest one is not automatically the right one: the CI runner image ships
# 37.0.0, whose apksigner names its output differently ("V2 Signer: certificate
# SHA-256 digest") from 34.0.0's ("Signer #1 certificate SHA-256 digest"). So
# prefer the version this script's prerequisites name and fall back to the rest,
# saying which binary answered — a check that cannot explain itself is not one.
BUILD_TOOLS="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}/build-tools"
PREFERRED=34.0.0
APKSIGNER=""
for cand in "$BUILD_TOOLS/$PREFERRED/apksigner" $(ls -1 "$BUILD_TOOLS"/*/apksigner 2>/dev/null | sort -r); do
  [ -x "$cand" ] && { APKSIGNER=$cand; break; }
done
[ -n "$APKSIGNER" ] || {
  echo "build-android-apk: no apksigner under $BUILD_TOOLS - cannot verify the signature" >&2
  exit 1
}

# Keep BOTH streams and the exit code: apksigner reports a failure ("DOES NOT
# VERIFY" + what failed) on STDERR, so reading only stdout used to turn "could
# not check for an environment reason" into a silent, wrong "not signed".
set +e
APKSIGNER_OUT=$("$APKSIGNER" verify --print-certs "$OUT" 2>&1)
APKSIGNER_RC=$?
set -e
# Every output shape seen so far — "Signer #1", "V2 Signer", ... — carries the
# same tail, so match the tail and not the prefix that version 37 changed.
GOT=$(printf '%s\n' "$APKSIGNER_OUT" \
  | sed -n 's/.*certificate SHA-256 digest: \([0-9a-fA-F]\{64\}\).*/\1/p' \
  | head -1 | tr 'A-Z' 'a-z')

if [ "$GOT" != "$EXPECT" ]; then
  echo "build-android-apk: SIGNED WITH THE WRONG KEY" >&2
  echo "  expected $EXPECT" >&2
  echo "  got      ${GOT:-<no signer certificate could be read>}" >&2
  echo "  $APKSIGNER (exit $APKSIGNER_RC) said:" >&2
  printf '%s\n' "$APKSIGNER_OUT" | sed 's/^/    /' >&2
  echo "  an install over the previous release would be refused; see android/README.md" >&2
  exit 1
fi
echo "build-android-apk: signature is the project key (cert sha256 $GOT, apksigner ${APKSIGNER#"$BUILD_TOOLS/"})"
