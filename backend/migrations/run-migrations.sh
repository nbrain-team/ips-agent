#!/usr/bin/env bash
# Run all migrations in order against $DATABASE_URL (falls back to .env).
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/run-migration.js all
