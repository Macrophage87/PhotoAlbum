#!/bin/sh
set -e
echo "[entrypoint] applying database migrations"
./node_modules/.bin/prisma migrate deploy
echo "[entrypoint] starting server"
exec node server.js
