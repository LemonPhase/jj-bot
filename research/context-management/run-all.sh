#!/usr/bin/env bash
# Runs every experiment variant N times on a real model, 4 at a time.
# Usage: research/context-management/run-all.sh [model] [repeats]
cd "$(dirname "$0")"
MODEL=${1:-openai/gpt-6-luna}
N=${2:-5}
jobs=()
add() { for i in $(seq 1 "$N"); do jobs+=("$1|$2|$3"); done; }
add followups e0 ""
add glossary e1-today ""
add glossary e1-push "JJ_EXP_DIGEST=1"
add glossary e1-pull "JJ_EXP_TASK_TOOLS=1"
add redelegate e2-fresh ""
add redelegate e2-resume "JJ_EXP_REDELEGATE=resume"
add redelegate e2-note "JJ_EXP_REDELEGATE=note"
add interface e3-message "JJ_EXP_VARIANT=message"
add interface e3-notes "JJ_EXP_VARIANT=notes JJ_EXP_NO_MESSAGE=1"
add interface e3-hub "JJ_EXP_VARIANT=hub JJ_EXP_NO_MESSAGE=1"
mkdir -p logs
printf '%s\n' "${jobs[@]}" | xargs -P 4 -I{} bash -c '
  IFS="|" read -r scenario label flags <<< "{}"
  env JJ_EXP_LABEL="$label" $flags timeout 1200 node --import tsx harness.ts "$scenario" '"$MODEL"' \
    > "logs/$label-$RANDOM$RANDOM.log" 2>&1
  echo "done $label exit $?"'
