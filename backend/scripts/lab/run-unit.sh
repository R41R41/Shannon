#!/bin/bash
# usage: run-unit.sh <out-file> [vitest args...]  — unit tests with offline placeholders only (no real keys, no DB)
OUT=$1; shift
cd /home/azureuser/Shannon-dev/backend
env -i HOME=$HOME PATH=/usr/bin:/bin OPENAI_API_KEY=offline-test-not-used MONGODB_URI=mongodb://127.0.0.1:1/shannon-offline-not-used \
  TWITTER_API_KEY=dummy TWITTER_API_KEY_SECRET=dummy TWITTER_ACCESS_TOKEN=dummy TWITTER_ACCESS_TOKEN_SECRET=dummy NOTION_API_KEY=dummy GOOGLE_API_KEY=dummy SEARCH_ENGINE_ID=dummy \
  bash ../scripts/with-dev-node.sh npx vitest run "${@:-tests/unit}" > "$OUT" 2>&1
echo "EXIT=$?"
sed 's/\x1b\[[0-9;]*m//g' "$OUT" | grep -a "^ *[×✗] \| FAIL \|AssertionError\|Test Files\|      Tests\|Error:" | cut -c1-240 | head -40
