#!/usr/bin/env bash
# Fetch nodejs-mobile's Android libnode builds, pinned, into this project:
#   android/app/src/main/jniLibs/<abi>/libnode.so   the engine (Node 18 LTS)
#   android/app/src/main/cpp/include/node/          headers for our JNI shim
# Pinned to nodejs-mobile v18.20.4 (Node 18.20.4) — see
# docs/android/02-移植方案.md §9 (lock the LTS, keep the aar out of the repo:
# these artifacts are gitignored, re-fetch with this script).
# Run from anywhere:  scripts/fetch-android-libnode.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=18.20.4
SHA256=bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${VERSION}/nodejs-mobile-v${VERSION}-android.zip"
ZIP=android/.cache/nodejs-mobile-v${VERSION}-android.zip
JNI_LIBS=android/app/src/main/jniLibs
CPP=android/app/src/main/cpp
STAGE=android/.cache/nm-extract

mkdir -p "$(dirname "$ZIP")"
if [ ! -f "$ZIP" ]; then
  echo "fetch-android-libnode: downloading v${VERSION} ..."
  curl -sL --fail -o "$ZIP" "$URL"
fi
echo "$SHA256  $ZIP" | sha256sum -c -

rm -rf "$STAGE" "$JNI_LIBS" "$CPP/include"
mkdir -p "$STAGE"
unzip -q -o "$ZIP" 'bin/*/libnode.so' 'include/*' -d "$STAGE"

for abi in arm64-v8a armeabi-v7a x86_64; do
  mkdir -p "$JNI_LIBS/$abi"
  mv "$STAGE/bin/$abi/libnode.so" "$JNI_LIBS/$abi/libnode.so"
done
mkdir -p "$CPP/include"
mv "$STAGE/include/node" "$CPP/include/node"
rm -rf "$STAGE"

echo "fetch-android-libnode: installed"
ls -la "$JNI_LIBS"/*/
