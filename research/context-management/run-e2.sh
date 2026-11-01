#!/usr/bin/env bash
# Re-runs E2 only (fixed scenario). Usage: run-e2.sh [model] [repeats]
cd "$(dirname "$0")"
MODEL=${1:-openai/gpt-6-luna}; N=${2:-5}
jobs=()
for i in $(seq 1 "$N"); do jobs+=("e2-fresh|" "e2-resume|JJ_EXP_REDELEGATE=resume" "e2-note|JJ_EXP_REDELEGATE=note"); done
mkdir -p logs
printf '%s\n' "${jobs[@]}" | xargs -P 4 -I{} bash -c '
  IFS="|" read -r label flags <<< "{}"
  env JJ_EXP_LABEL="$label" $flags timeout 1200 node --import tsx harness.ts redelegate '"$MODEL"' > "logs/$label-$RANDOM$RANDOM.log" 2>&1
  echo "done $label exit $?"'
