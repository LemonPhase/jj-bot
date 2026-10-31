import assert from "node:assert/strict";

const base = process.env.JJ_SMOKE_URL ?? "http://127.0.0.1:3001";
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.API_TOKEN)
  headers.Authorization = `Bearer ${process.env.API_TOKEN}`;
async function api(path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function main() {
  const a = await api("/bots", {
    name: "Smoke coordinator",
    instructions:
      "Solve the supplied arithmetic request. In your final answer include the exact digits 42. Use tools when appropriate. Do not delegate; the test already schedules collaborators.",
  });
  const b = await api("/bots", {
    name: "Smoke checker",
    instructions:
      "Independently check the supplied arithmetic. In your final answer include the exact digits 42. Use add_numbers to establish the answer. Do not delegate.",
  });
  const task = await api("/tasks", {
    goal: "Calculate 19 + 23 using add_numbers and explain the result. Final answer must include 42.",
    coordinatorBotId: a.id,
    participantBotIds: [a.id, b.id],
    verificationPlan: [
      {
        id: "sum",
        description: "Correct answer includes 42",
        method: "Deterministic output check",
        expectedEvidence: "Output includes 42; backend tool result in events",
      },
    ],
    checks: [{ id: "sum", kind: "contains", value: "42" }],
  });
  const deadline = Date.now() + 120000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await api(`/tasks/${task.id}`);
    if (
      ["completed", "failed", "waiting", "cancelled"].includes(
        snapshot.task.status,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(
    snapshot.task.status,
    "completed",
    JSON.stringify(snapshot.task),
  );
  assert.ok(
    snapshot.sessions.filter(
      (s: { kind: string; status: string }) =>
        s.kind === "work" && s.status === "completed",
    ).length >= 2,
  );
  assert.ok(
    snapshot.sessions.some((s: { kind: string }) => s.kind === "synthesis"),
  );
  assert.ok(
    snapshot.events.some((e: { type: string }) => e.type === "tool.finished"),
  );
  assert.ok(snapshot.checks.length >= 3);
  const view = await api(`/tasks/${task.id}/view`);
  assert.equal(view.participants.length, 2);
  assert.equal(view.replayCursor, snapshot.events.at(-1)?.sequence ?? 0);
  const cursor = snapshot.events.at(-2)?.sequence ?? 0;
  const replay = await api(`/tasks/${task.id}/events?after=${cursor}`);
  assert.ok(
    replay.events.every((e: { sequence: number }) => e.sequence > cursor),
  );
  const count = snapshot.sessions.length;
  await api(`/tasks/${task.id}/messages`, {
    authorKind: "user",
    authorId: "smoke-user",
    text: "Informational update; do not activate bots.",
    intent: "notification",
    activateBotIds: [],
  });
  assert.equal((await api(`/tasks/${task.id}`)).sessions.length, count);
  console.info(
    JSON.stringify({
      status: "passed",
      taskId: task.id,
      bots: 2,
      sessions: snapshot.sessions.length,
      checks: snapshot.checks.length,
      result: snapshot.task.result,
      eventCount: snapshot.events.length,
    }),
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Smoke failure");
  process.exitCode = 1;
});
