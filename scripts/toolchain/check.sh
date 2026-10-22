#!/usr/bin/env bash
# Fourteen probes, each bounded to 3 s plus a 0.5 s kill grace: < 60 s total.
set -u

failed=0
for tool in node pnpm forge anvil cast solana anchor tronbox slither jq cargo rustc cloudflared gh; do
  argument=--version
  if [[ "$tool" == tronbox ]]; then
    argument=version
  fi

  if output=$(timeout --kill-after=0.5s 3s "$tool" "$argument" 2>&1); then
    printf 'PASS %-12s %s\n' "$tool" "${output//$'\n'/ | }"
  else
    status=$?
    printf 'FAIL %-12s exit=%s %s\n' "$tool" "$status" "${output//$'\n'/ | }"
    failed=1
  fi
done

exit "$failed"
