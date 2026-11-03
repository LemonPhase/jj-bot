// A stdio MCP server for tests, run in a sandbox through `Sandbox.spawn`:
// newline-delimited JSON-RPC on stdin and stdout, plain Node, no packages.
// With `--silent` it never answers `initialize`. Its tools:
// - echo: answers with its arguments as JSON;
// - crash: writes FIXTURE_SECRET to stderr, then exits with code 3 mid-call;
// - flood: writes one line of 5 MiB to stdout;
// - leak: writes FIXTURE_SECRET to stderr, then answers.
// It exits when its stdin closes.
import { createInterface } from "node:readline";

const silent = process.argv.includes("--silent");
const tools = ["echo", "crash", "flood", "leak"].map((name) => ({
  name,
  description: `The ${name} tool of the fixture.`,
  inputSchema: { type: "object" },
}));

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function call(id, name, args) {
  const reply = (text) =>
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
  switch (name) {
    case "echo":
      reply(JSON.stringify(args));
      return;
    case "crash":
      process.stderr.write(`fatal: lost ${process.env.FIXTURE_SECRET}\n`, () =>
        process.exit(3),
      );
      return;
    case "flood": {
      const chunk = "x".repeat(64 * 1024);
      let left = 80;
      const pump = () => {
        while (left-- > 0)
          if (!process.stdout.write(chunk)) {
            process.stdout.once("drain", pump);
            return;
          }
        process.stdout.write("\n");
      };
      pump();
      return;
    }
    case "leak":
      process.stderr.write(`using ${process.env.FIXTURE_SECRET}\n`);
      reply("ok");
      return;
    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    if (!silent)
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
      });
  } else if (message.method === "tools/list")
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  else if (message.method === "tools/call")
    call(message.id, message.params?.name, message.params?.arguments ?? {});
  else
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
});
lines.on("close", () => process.exit(0));
