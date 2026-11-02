#!/bin/bash
# wsl-lab-setup.sh — makes the PC's WSL (Ubuntu-24.04, user ghrunner) look like the VM for the lab scripts, so the second lab runs
# every script of this directory unchanged while the production run keeps the VM busy. Idempotent. Downloads nothing: the only
# outside things are the Ubuntu package openjdk-21-jre-headless (installed once, as root, by hand: see below) and the server template
# copied from the VM (Mojang's 1.21.11 server jar and the Fabric launcher it already holds).
#
#   one time, as root (the PowerShell/Bash tool of the owner's PC):
#     wsl -d Ubuntu-24.04 -u root -- bash -lc 'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openjdk-21-jre-headless'
#     wsl -d Ubuntu-24.04 -u root -- ln -s /home/ghrunner/minebot-lab/vmhome /home/azureuser          # the VM's paths, for the probes' isolation checks
#   then as ghrunner:   wsl -d Ubuntu-24.04 -u ghrunner -- env HOME=/home/azureuser bash <this file> [--deps-from /home/ghrunner/bodyend-deps]
#
# What it builds under /home/azureuser (= /home/ghrunner/minebot-lab/vmhome):
#   minecraft/1.21.11-fabric-test      the lab server template (copied from the VM once: scp/tar of ~/minecraft/1.21.11-fabric-test)
#   .cache/minebot-lab                 MINEBOT_LAB_SCRATCH (outputs; never /tmp)
#   Shannon-dev                        node_modules (hard links from --deps-from, no copy, no download), .nvmrc, .shannon-development,
#                                      scripts/with-dev-node.sh; the lab scripts read only these, the code comes in a tar (run-hands-live.sh)
#   .nvm/versions/node/v<.nvmrc>       a link to the Node of the CI runner (24.20.0): the WSL has no Node 22 and may only fetch from Mojang
#                                      and Ubuntu. A probe that behaves differently on Node 24 than on the VM's 22.21.1 is a finding, not a bug of the lab.
set -eu
[ "$HOME" = /home/azureuser ] || { echo "run with HOME=/home/azureuser (env HOME=/home/azureuser bash $0)" >&2; exit 2; }
DEPS=/home/ghrunner/bodyend-deps
NODE_HOME=/home/ghrunner/actions-runner/_work/_tool/node/24.20.0/x64
SRC_SCRIPTS=${LAB_SCRIPTS_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}      # the worktree's backend/
while [ $# -gt 0 ]; do case "$1" in --deps-from) DEPS=$2; shift 2 ;; *) echo "unknown: $1" >&2; exit 2 ;; esac; done

say() { echo "[wsl-lab-setup] $*"; }
command -v java >/dev/null || { echo "no java: install openjdk-21-jre-headless first (see the top of this file)" >&2; exit 1; }
java -version 2>&1 | head -1
[ -f "$HOME/minecraft/1.21.11-fabric-test/fabric-server-launch.jar" ] || { echo "no server template in $HOME/minecraft/1.21.11-fabric-test (copy it from the VM)" >&2; exit 1; }
[ -x "$NODE_HOME/bin/node" ] || { echo "no node at $NODE_HOME" >&2; exit 1; }

mkdir -p "$HOME/.cache/minebot-lab" "$HOME/.nvm/versions/node"
ln -sfn "$NODE_HOME" "$HOME/.nvm/versions/node/v22.21.1"
say "node: $("$HOME/.nvm/versions/node/v22.21.1/bin/node" --version) under the name v22.21.1"

DEV=$HOME/Shannon-dev
mkdir -p "$DEV/backend" "$DEV/scripts"
if [ ! -d "$DEV/node_modules" ]; then
  [ -d "$DEPS/node_modules" ] || { echo "no node_modules in $DEPS" >&2; exit 1; }
  cp -al "$DEPS/node_modules" "$DEV/node_modules"
  [ -d "$DEPS/backend/node_modules" ] && cp -al "$DEPS/backend/node_modules" "$DEV/backend/node_modules"
  say "node_modules hard-linked from $DEPS"
else
  say "node_modules already there"
fi
echo 22.21.1 > "$DEV/.nvmrc"
touch "$DEV/.shannon-development"
cp "$SRC_SCRIPTS/../scripts/with-dev-node.sh" "$DEV/scripts/with-dev-node.sh" 2>/dev/null || true
for m in mineflayer ts-node minecraft-protocol; do
  p=$DEV/node_modules/$m/package.json; [ -f "$p" ] || p=$DEV/backend/node_modules/$m/package.json
  [ -f "$p" ] && say "$m $(grep -m1 '"version"' "$p" | tr -d ' ,')" || say "WARNING: $m not found"
done
say "lab slot rules: bash $SRC_SCRIPTS/scripts/lab/lab-slot.sh status   (LAB_SLOT_COUNT=3 here)"
say "done"
