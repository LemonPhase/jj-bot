// Aggregates real-model reports by experiment label into results/summary.json.
const fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "results");
const model = process.argv[2] ?? "openai_gpt_6_luna";
const groups = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.includes(model) || f === "summary.json") continue;
  const m = /^[a-z]+\.([a-z0-9-]+)-/.exec(f);
  if (!m) continue;
  (groups[m[1]] ??= []).push(JSON.parse(fs.readFileSync(path.join(dir, f))));
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const out = {};
for (const [label, runs] of Object.entries(groups).sort()) {
  const prompt = runs.map((r) => r.totals.usage.input + r.totals.usage.cacheRead);
  const checks = {};
  for (const r of runs)
    for (const [k, v] of Object.entries(r.outcome?.checks ?? {}))
      checks[k] = (checks[k] ?? 0) + (v ? 1 : 0);
  const tools = {};
  for (const r of runs)
    for (const [k, v] of Object.entries(r.toolCalls ?? {})) tools[k] = (tools[k] ?? 0) + v / runs.length;
  const byRole = (role) => mean(runs.map((r) => r.sessions.filter((s) => s.role === role).reduce((a, s) => a + s.usage.input + s.usage.cacheRead, 0)));
  out[label] = {
    n: runs.length,
    pass: runs.filter((r) => r.outcome?.pass).length,
    completed: runs.filter((r) => [r.outcome].flat().at(-1)?.status === "completed").length,
    checks,
    promptTokens: Math.round(mean(prompt)),
    coordinatorPrompt: Math.round(byRole("coordinator")),
    workerPrompt: Math.round(byRole("worker")),
    outputTokens: Math.round(mean(runs.map((r) => r.totals.usage.output))),
    modelCalls: +mean(runs.map((r) => r.totals.modelCalls)).toFixed(1),
    costUsd: +mean(runs.map((r) => r.totals.usage.costUsd)).toFixed(5),
    totalCostUsd: +runs.reduce((a, r) => a + r.totals.usage.costUsd, 0).toFixed(5),
    wallS: +mean(runs.map((r) => r.wallMs / 1000)).toFixed(1),
    workerSessions: +mean(runs.map((r) => r.sessions.filter((s) => s.role === "worker").length)).toFixed(1),
    extra: {
      botMessages: mean(runs.map((r) => r.outcome?.botMessages ?? 0)),
      fixDelegations: mean(runs.map((r) => r.outcome?.fixDelegations ?? 0)),
      notesFile: runs.filter((r) => r.outcome?.notesFile).length,
    },
    tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, +v.toFixed(1)]).sort()),
  };
}
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(out, null, 2));
const total = Object.values(out).reduce((a, g) => a + g.totalCostUsd, 0);
for (const [k, g] of Object.entries(out))
  console.log(k.padEnd(12), `n=${g.n} pass=${g.pass} done=${g.completed}`, JSON.stringify(g.checks), `prompt=${g.promptTokens} (coord ${g.coordinatorPrompt}, workers ${g.workerPrompt}) out=${g.outputTokens} calls=${g.modelCalls} $${g.costUsd} ${g.wallS}s w=${g.workerSessions}`, JSON.stringify(g.extra));
console.log("total real-model cost $" + total.toFixed(4));
