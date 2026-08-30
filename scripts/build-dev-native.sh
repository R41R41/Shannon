#!/usr/bin/env bash
# Ubuntu 20.04 / x64 development build. Downloads/extracts tools privately; never apt-installs or changes shared libc.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
[[ "$(basename "$REPO_ROOT")" == Shannon-dev ]] || { echo 'VM development checkout required'; exit 2; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'This recipe is for x64 only'; exit 2; }
DEV_NODE_BIN="$HOME/.nvm/versions/node/v$(cat "$REPO_ROOT/.nvmrc")/bin"
[[ -x "$DEV_NODE_BIN/node" ]] || exit 2
export PATH="$DEV_NODE_BIN:$PATH"
BUILD_ROOT="${SHANNON_NATIVE_BUILD_ROOT:-$HOME/.cache/shannon-native-build}"
mkdir -p "$BUILD_ROOT/toolchain"
python3 -m pip install --disable-pip-version-check --target "$BUILD_ROOT/python" cmake==3.31.6
cd "$BUILD_ROOT"
npm install --ignore-scripts --no-audit --no-fund sodium-native@5.0.10 cmake-bare@1.6.1 cmake-fetch@1.4.3 cmake-napi@1.2.1 bare-compat-napi@1.3.5
cd toolchain
apt-get download g++-10=10.5.0-1ubuntu1~20.04 gcc-10=10.5.0-1ubuntu1~20.04 cpp-10=10.5.0-1ubuntu1~20.04 libstdc++-10-dev=10.5.0-1ubuntu1~20.04 libgcc-10-dev=10.5.0-1ubuntu1~20.04
for pkg in ./*.deb; do dpkg-deb -x "$pkg" root; done
cd "$BUILD_ROOT"
# Pin the formerly floating libsodium stable ref to the source used in the verified build.
python3 - "$BUILD_ROOT/node_modules/sodium-native/CMakeLists.txt" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text();s=s.replace('github:jedisct1/libsodium#stable','github:jedisct1/libsodium#1899e2061a74798906d52ace044050c12ad41b99');p.write_text(s)
PY
CMAKE="$BUILD_ROOT/python/cmake/data/bin/cmake"
"$CMAKE" -S node_modules/sodium-native -B build-gcc10 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER="$BUILD_ROOT/toolchain/root/usr/bin/g++-10" -DCMAKE_PREFIX_PATH="$BUILD_ROOT/node_modules"
nice -n 10 "$CMAKE" --build build-gcc10 --parallel 1
# Keep artifacts out of Git. The functional probe must pass after installation.
cp build-gcc10/sodium-native.node "$REPO_ROOT/node_modules/sodium-native/prebuilds/linux-x64/sodium-native.node"
cd "$REPO_ROOT"
if ! node -e "require('@discordjs/opus')" >/dev/null 2>&1; then
  (cd node_modules/@discordjs/opus && node "$REPO_ROOT/node_modules/@mapbox/node-pre-gyp/bin/node-pre-gyp" install --fallback-to-build)
fi
if ! node -e "require('canvas')" >/dev/null 2>&1; then
  (cd node_modules/canvas && npm run install)
fi
node scripts/probe-dev-native.cjs
