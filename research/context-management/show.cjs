// Prints the newest report of each scenario (or the files given) as a per-call table.
const fs = require("fs"),
  path = require("path");
const dir = path.join(__dirname, "results");
let files = process.argv.slice(2);
if (files.length === 0) {
  const newest = {};
  for (const f of fs.readdirSync(dir)) {
    const key = f.split("-").slice(0, -1).join("-");
    if (!newest[key] || f > newest[key]) newest[key] = f;
  }
  files = Object.values(newest).map((f) => path.join(dir, f));
}
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f));
  console.log(
    `== ${r.scenario} on ${r.model}: ${r.totals.modelCalls} calls, ~${r.totals.estInputTokens} input tokens (est), usage ${JSON.stringify(r.totals.usage)}, ${r.wallMs} ms`,
  );
  const name = new Map(r.sessions.map((s) => [s.id, `${s.bot}/${s.role[0]}`]));
  for (const c of r.calls)
    console.log(
      c.index,
      name.get(c.sessionId) || "chat",
      "msgs",
      c.messages,
      "sys",
      c.systemChars,
      "tools",
      c.toolsChars,
      JSON.stringify(c.byRole),
      "~tok",
      Math.round(c.totalChars / 4),
    );
}
