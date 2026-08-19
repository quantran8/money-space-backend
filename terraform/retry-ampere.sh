#!/usr/bin/env bash
#
# Retry the Ampere instance until OCI has capacity for it.
#
# Free A1 capacity is contended and frees up unpredictably when other tenants
# release hosts, so getting one is a matter of asking repeatedly rather than
# asking differently. The network resources already exist after the first
# apply, so each attempt is only the instance and its reserved IP — a few
# seconds of API calls.
#
#   ./retry-ampere.sh              # retry every 30s, forever
#   ./retry-ampere.sh 60           # retry every 60s
#   ./retry-ampere.sh 30 100       # every 30s, give up after 100 attempts
#
# Ctrl-C stops it. Terraform is never interrupted mid-apply: the trap only
# takes effect between attempts, so the state file is not left locked.

set -uo pipefail

INTERVAL="${1:-30}"
MAX_ATTEMPTS="${2:-0}"        # 0 = unlimited
cd "$(dirname "$0")"

# Colours, but only when writing to a terminal.
if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
else
  R=""; G=""; Y=""; B=""; N=""
fi

LOG="retry-ampere.log"
stop_requested=0
# Handle Ctrl-C between attempts rather than during one: killing terraform
# mid-apply can leave a lock behind, and worse, an instance created in OCI that
# the state file does not know about.
trap 'stop_requested=1; printf "\n%s\n" "${Y}Stopping after this attempt…${N}"' INT TERM

printf '%s\n' "${B}Retrying VM.Standard.A1.Flex every ${INTERVAL}s${N}"
printf 'Logging to %s — Ctrl-C to stop\n\n' "$LOG"

attempt=0
while :; do
  attempt=$((attempt + 1))
  ts=$(date '+%H:%M:%S')

  printf '[%s] attempt %d… ' "$ts" "$attempt"
  output=$(terraform apply -input=false -auto-approve -no-color 2>&1)
  status=$?

  if [ $status -eq 0 ]; then
    printf '%s\n\n' "${G}capacity found${N}"
    echo "[$ts] attempt $attempt: SUCCESS" >> "$LOG"

    ip=$(terraform output -raw instance_public_ip 2>/dev/null)
    printf '%s\n' "${B}Instance created.${N}"
    printf '\n%s\n' "${B}Next: point the domain at it${N}"
    printf '  1. Open https://dash.domain.digitalplat.org\n'
    printf '  2. Add an A record:  moneytogether  ->  %s  (TTL 300)\n' "$ip"
    printf '  3. Confirm it resolves:\n'
    printf '       dig +short moneytogether.dpdns.org\n'
    printf '\n%s\n' "${B}Then: GitHub secrets and variables${N}"
    printf '       terraform output github_secrets_checklist\n'
    printf '       terraform output -raw image_platform     # BUILD_PLATFORM\n\n'
    exit 0
  fi

  if grep -q "Out of host capacity" <<<"$output"; then
    printf '%s\n' "${Y}out of capacity${N}"
    echo "[$ts] attempt $attempt: out of capacity" >> "$LOG"
  else
    # Anything else — a quota limit, expired credentials, a config error — will
    # not fix itself by waiting, so stop and show it rather than looping on it.
    printf '%s\n\n' "${R}unexpected error${N}"
    echo "[$ts] attempt $attempt: UNEXPECTED ERROR" >> "$LOG"
    grep -E "^(Error|│ Error)" <<<"$output" | head -5 | tee -a "$LOG"
    printf '\n%s\n' "Stopped: this is not a capacity problem, so retrying will not help."
    printf 'Full output of the last attempt:\n\n%s\n' "$output" >> "$LOG"
    printf 'See %s for the full output.\n' "$LOG"
    exit 1
  fi

  if [ "$stop_requested" -eq 1 ]; then
    printf '\n%s\n' "Stopped after $attempt attempts. Nothing was left half-created."
    exit 130
  fi

  if [ "$MAX_ATTEMPTS" -gt 0 ] && [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    printf '\n%s\n' "Gave up after $attempt attempts."
    printf 'Ampere capacity in this region may be scarce for a while. The x86\n'
    printf 'fallback is ready when you want it:\n\n'
    printf '  terraform apply -var-file=terraform.tfvars -var-file=x86.tfvars\n\n'
    exit 2
  fi

  sleep "$INTERVAL"
done
