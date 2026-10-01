#!/bin/sh
# Browser dependencies stay inside this lab; no apt installation is needed here.
set -eu
cd "$(dirname "$0")/.."
if [ -d .runtime/root/usr/lib/aarch64-linux-gnu ]; then
    export LD_LIBRARY_PATH="$PWD/.runtime/root/usr/lib/aarch64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
if [ -d .runtime/browsers ]; then
    export PLAYWRIGHT_BROWSERS_PATH="$PWD/.runtime/browsers"
fi
exec node --env-file-if-exists=.env test/webrtc.js
