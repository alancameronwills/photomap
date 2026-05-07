#!/usr/bin/env bash
# Usage:
#   First deploy:   ./scripts/deploy.sh --guided
#   Subsequent:     ./scripts/deploy.sh
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - AWS SAM CLI installed (brew install aws-sam-cli / pip install aws-sam-cli)
#   - Docker running (SAM build uses it to cross-compile sharp for Linux)

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building Lambda package..."
sam build

if [[ "${1:-}" == "--guided" ]]; then
  echo "==> First-time deploy (guided)..."
  sam deploy --guided \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides \
      "AdminPassword=${ADMIN_PASSWORD:-changeme}" \
      "SessionSecret=${SESSION_SECRET:-$(openssl rand -hex 32)}"
else
  echo "==> Deploying..."
  sam deploy --capabilities CAPABILITY_IAM
fi

echo ""
echo "==> Done. App URL is in the Outputs above."
