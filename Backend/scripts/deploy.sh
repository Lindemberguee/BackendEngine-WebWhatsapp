#!/usr/bin/env bash
# Redeploys the backend on the VPS: pulls the latest code, rebuilds the Docker image,
# and restarts the compose stack. Invoked over SSH by .github/workflows/deploy.yml —
# see that file for the secrets (VPS_HOST/VPS_USER/VPS_SSH_KEY) it depends on.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/app}"

cd "$DEPLOY_DIR"
echo "[deploy] Pulling latest main..."
git pull origin main

cd Backend
echo "[deploy] Building image..."
docker compose build

echo "[deploy] Restarting stack..."
docker compose up -d

echo "[deploy] Done. Recent container status:"
docker compose ps
