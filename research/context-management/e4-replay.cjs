// E4: offline replay. For every real-model run, rebuild each session's tool
// results from the recorded per-call sizes (the growth of tool-result text
// between consecutive calls is the batch of results added), then recompute
// every call's size if results older than the newest K batches were replaced
// by a short stub. No model calls.
const fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "results");
const STUB = 120; // chars: "[output cleared; saved as artifact …]"
const files = fs.readdirSync(dir).filter((f) => f.includes("luna") && /^[a-z]+\.[a-z0-9-]+-/.test(f));
const policies = [1, 3, 5];
const byExp = {};
let all = { total: 0, toolResult: 0, assistant: 0, user: 0, fixed: 0 };
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f)));
  const label = /^[a-z]+\.([a-z0-9-]+)-/.exec(f)[1].split("-")[0];
  const g = (byExp[label] ??= { runs: 0, total: 0, toolResult: 0, saved: Object.fromEntries(policies.map((k) => [k, 0])) });
  g.runs++;
  const sessions = {};
  for (const c of r.calls) (sessions[c.sessionId] ??= []).push(c);
  for (const calls of Object.values(sessions)) {
    let prev = 0;
    const batches = [];
    for (const c of calls) {
      const t = c.byRole.toolResult ?? 0;
      if (t > prev) batches.push(t - prev);
      prev = t;
      g.total += c.totalChars; g.toolResult += t;
      all.total += c.totalChars; all.toolResult += t;
      all.assistant += c.byRole.assistant ?? 0; all.user += c.byRole.user ?? 0;
      all.fixed += c.systemChars + c.toolsChars;
      for (const k of policies) {
        const old = batches.slice(0, Math.max(0, batches.length - k));
        g.saved[k] += old.reduce((a, b) => a + Math.max(0, b - STUB), 0);
      }
    }
  }
}
const pct = (a, b) => ((100 * a) / b).toFixed(1) + "%";
console.log(`Share of all prompt characters, ${files.length} real runs:`);
console.log(` fixed prefix ${pct(all.fixed, all.total)}, tool results ${pct(all.toolResult, all.total)}, assistant ${pct(all.assistant, all.total)}, user/inbox ${pct(all.user, all.total)}`);
const out = { share: { fixed: all.fixed / all.total, toolResult: all.toolResult / all.total, assistant: all.assistant / all.total, user: all.user / all.total }, byExp: {} };
for (const [k, g] of Object.entries(byExp)) {
  out.byExp[k] = { runs: g.runs, toolResultShare: g.toolResult / g.total, saving: Object.fromEntries(policies.map((p) => [p, g.saved[p] / g.total])) };
  console.log(k, `runs=${g.runs}`, `tool results ${pct(g.toolResult, g.total)} of prompt;`, policies.map((p) => `keep ${p}: −${pct(g.saved[p], g.total)}`).join(", "));
}
fs.writeFileSync(path.join(__dirname, "05-e4.json"), JSON.stringify(out, null, 2));
