#!/usr/bin/env bash
# Verifies CloudTrail auditing in the Sandbox using the event history
# (90 days). The Sandbox denies cloudtrail:CreateTrail, but allows
# cloudtrail:LookupEvents.
#
# Usage: AWS_PROFILE=academy ./scripts/verify-cloudtrail.sh [max_resultados]
set -euo pipefail

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI no encontrado" >&2
  exit 1
fi

REGION="${AWS_REGION:-us-east-1}"
MAX_RESULTS="${1:-10}"

if ! [[ "$MAX_RESULTS" =~ ^[0-9]+$ ]]; then
  echo "max_resultados debe ser un número entero" >&2
  exit 1
fi

aws cloudtrail lookup-events \
  --region "$REGION" \
  --max-results "$MAX_RESULTS" \
  --query 'Events[].{Time:EventTime,Event:EventName,Source:EventSource,User:Username}' \
  --output table
