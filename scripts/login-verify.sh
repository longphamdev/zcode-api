#!/bin/bash
# Login + verify per acc: credentials.json must appear in ./data/auth after each.
set -e
cd /home/longphamdev/codespaces/zcode-api
LABEL=$1
echo "=== Login $LABEL — mở URL, authorize, đợi hoàn tất..."
docker run --rm -it -v /home/longphamdev/codespaces/zcode-api/data/auth:/data/auth zcode-proxy:local bun /app/index.js auth login zai --label "$LABEL"
if [ -f ./data/auth/credentials.json ]; then
  echo "✓ credentials.json EXISTS in ./data/auth"
  python3 -c "
import json
d = json.load(open('./data/auth/credentials.json'))
print('✓ accounts in store:', len(d.get('accounts', [])))
"
else
  echo "✗ credentials.json NOT written — something is wrong, stop and investigate"
  exit 1
fi
