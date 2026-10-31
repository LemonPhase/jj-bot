import assert from "node:assert/strict";
import { createGoogleClient } from "@jj/runtime";

const mode = process.argv[2];
const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
const model = process.env.GEMINI_MODEL?.trim() ?? "";

async function main() {
  const client = createGoogleClient({ apiKey, model });
  const options = { timeout: 30_000, maxRetries: 0 };
  const started = Date.now();
  if (mode === "model") {
    const response = await client.interactions.create(
      {
        model,
        store: false,
        input: "Reply with exactly JJ_SMOKE_OK and nothing else.",
      },
      options,
    );
    assert.equal(
      response.output_text?.trim(),
      "JJ_SMOKE_OK",
      "Unexpected smoke response",
    );
    console.info(
      JSON.stringify({
        test: "model",
        status: "passed",
        model,
        api: "interactions",
        output: response.output_text,
        durationMs: Date.now() - started,
      }),
    );
    return;
  }
  if (mode !== "tool") throw new Error("Choose model or tool smoke mode.");
  const prompt =
    "Call add_numbers with a=19 and b=23. After receiving its result, reply with only the sum as digits.";
  const tools = [
    {
      type: "function" as const,
      name: "add_numbers",
      description: "Add two integers on the backend.",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
    },
  ];
  const first = await client.interactions.create(
    { model, store: false, input: prompt, tools },
    options,
  );
  const call = first.steps.find((step) => step.type === "function_call");
  assert.ok(
    call && call.type === "function_call",
    "Model did not request a tool",
  );
  assert.equal(call.name, "add_numbers");
  const args = call.arguments as { a?: unknown; b?: unknown };
  assert.equal(args.a, 19);
  assert.equal(args.b, 23);
  // Only this allowlisted function executes; model output is never evaluated as code.
  const sum = Number(args.a) + Number(args.b);
  const final = await client.interactions.create(
    {
      model,
      store: false,
      input: [
        { type: "user_input", content: [{ type: "text", text: prompt }] },
        ...first.steps,
        {
          type: "function_result",
          name: call.name,
          call_id: call.id,
          result: [{ type: "text", text: JSON.stringify({ sum }) }],
        },
      ],
    },
    options,
  );
  assert.equal(
    final.output_text?.trim(),
    "42",
    "Model did not return the backend tool result",
  );
  console.info(
    JSON.stringify({
      test: "tool",
      status: "passed",
      model,
      api: "interactions",
      tool: call.name,
      args,
      backendResult: sum,
      output: final.output_text,
      durationMs: Date.now() - started,
    }),
  );
}

main().catch((error: unknown) => {
  // Never dump SDK request objects, headers, environment values or stack traces.
  const message =
    error instanceof Error ? error.message : "Unknown smoke test failure";
  const redacted = apiKey ? message.split(apiKey).join("[REDACTED]") : message;
  console.error(
    JSON.stringify({
      test: mode,
      status: "failed",
      model,
      message: redacted.slice(0, 1500),
    }),
  );
  process.exitCode = 1;
});
