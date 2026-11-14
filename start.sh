#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "插头学堂启动中... http://127.0.0.1:${PORT:-8710}"
exec node --no-warnings server.js