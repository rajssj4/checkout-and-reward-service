#!/bin/sh
set -eu
node dist/db/initialize.js
exec node dist/server.js
