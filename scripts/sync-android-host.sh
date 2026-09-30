#!/usr/bin/env bash
# Assemble the WebView app's assets from the repo (the ONLY place repo layout
# is mapped onto the Android package):
#   android/app/src/main/assets/nodejs-project/  the Node host (NodeEngine
#       copies this to filesDir at boot; entry = index.js)
#   android/app/src/main/assets/ui/              the render layer (loaded by
#       WebViewAssetLoader at https://appassets.androidplatform.net/ui/)
# The host gets the SAME files the desktop runs: android/host/* + the pure-Node
# ui/ subset (R1-R4 kept them Electron-free). The Electron-only modules
# (main.js, preload.js, server-bootstrap.js) stay out by construction.
# Run from anywhere:  scripts/sync-android-host.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ASSETS=android/app/src/main/assets
NODEJS_PROJECT=$ASSETS/nodejs-project
UI_ASSETS=$ASSETS/ui

# the pure-Node subset the host resolves via useUI(): the modules it names plus
# their own ui/-relative requires (the tunnel is six files over one state
# object), plus the shared transport defaults and the component source list
# (components.js reads it from __dirname; without it the phone hands the far
# side nothing to install).
UI_NODE="components.js components.sources.json exec-bridge.js host-core.js llm-proxy.js server-bundle.js settings-mirror.js ssh-tunnel.js tunnel-core.js tunnel-net.js tunnel-remote.js tunnel-bootstrap.js tunnel-lifecycle.js tunnel-connect.js supervisor-client.js transport_defaults.json"

# 1. nodejs-project = android/host + ui/ subset + production node_modules
rm -rf "$NODEJS_PROJECT"
mkdir -p "$NODEJS_PROJECT/ui"
cp android/host/*.js android/host/package.json "$NODEJS_PROJECT/"
for f in $UI_NODE; do cp "ui/$f" "$NODEJS_PROJECT/ui/"; done
(cd "$NODEJS_PROJECT" && npm install --omit=dev --no-audit --no-fund)

# 2. assets/ui = exactly what ui/index.html pulls (styles/scripts/vendor)
rm -rf "$UI_ASSETS"
mkdir -p "$UI_ASSETS"
cp ui/index.html ui/app.js ui/style.css ui/mobile.css ui/bridge-shim.js "$UI_ASSETS/"
# the renderer's own modules (ui/js) + the vendored third-party libraries
cp -r ui/js "$UI_ASSETS/js"
cp -r ui/vendor "$UI_ASSETS/vendor"

# 3. the N3 stamp, when this machine has one (build-android-apk.sh writes it
#    right before calling us). Optional for dev: its absence just means the
#    host falls back to the released latest index. `if`, not `&&`: under
#    set -e a failed test would kill the script.
if [ -f android/host/pylibs-index-url.txt ]; then
  cp android/host/pylibs-index-url.txt "$NODEJS_PROJECT/"
fi

echo "sync-android-host: assets ready"
du -sh "$NODEJS_PROJECT" "$UI_ASSETS"
