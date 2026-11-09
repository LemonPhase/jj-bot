import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ERROR_CODES, capabilitiesSchema } from "./api";
import { CONTRACT_VERSION } from "./common";
import { applyTaskEvent, type TaskEvent, type TaskView } from "./events";
import { artifactSchema, createTaskCommandSchema } from "./tasks";
import {
  createTaskTemplateCommandSchema,
  startTemplateCommandSchema,
  templateTaskCommand,
} from "./templates";
import {
  formatUploadSize,
  stagedUploadSchema,
  uploadAnnouncement,
  uploadNameProblem,
  uploadPathProblem,
  uploadToTaskCommandSchema,
} from "./uploads";

const char = (code: number) => String.fromCodePoint(code);

describe("contract 1.11.0", () => {
  it("came with 1.11.0, and the changelog's newest entry is the current version", () => {
    const changelog = readFileSync(
      new URL("../../../docs/contract-changelog.md", import.meta.url),
      "utf8",
    );
    const newest = /^## (\d+\.\d+\.\d+) — /m.exec(changelog)?.[1];
    expect(newest).toBe(CONTRACT_VERSION);
    expect(changelog).toMatch(/^## 1\.11\.0 — .* — Uploads$/m);
    expect(API_ERROR_CODES).toContain("UPLOAD_TOO_LARGE");
  });
});

describe("upload paths", () => {
  it.each([
    ["uploads/a.csv"],
    ["a.csv"],
    ["data/2024/q1/report.final.pdf"],
    [".env"],
    ["uploads/.git"],
    [`notes/caf${char(0xe9)}.md`],
    [`emoji/${char(0x1f600)}.txt`],
    [`${"a/".repeat(7)}b`],
    [`${"x".repeat(255)}`],
  ])("accepts %j", (path) => {
    expect(uploadPathProblem(path)).toBeUndefined();
  });

  it.each([
    ["", /empty/],
    ["/etc/passwd", /absolute/],
    ["../x", /is \. or \.\./],
    ["a/../../x", /is \. or \.\./],
    ["a/./b", /is \. or \.\./],
    ["a//b", /empty/],
    ["a/", /empty/],
    ["a\\b", /backslash/],
    ["..\\x", /backslash/],
    [`a${char(0)}b`, /NUL/],
    ["a\nb", /control character \(U\+000A\)/],
    ["a\tb", /control character \(U\+0009\)/],
    [`a${char(0x85)}b`, /control character \(U\+0085\)/],
    [`a${char(0x2028)}b`, /control character \(U\+2028\)/],
    [`a${char(0x202e)}b`, /invisible/],
    [`a${char(0x200b)}b`, /invisible/],
    [`a${char(0xfeff)}b`, /invisible/],
    [`a${char(0xe0041)}b`, /invisible/],
    [`a${String.fromCharCode(0xd800)}b`, /lone surrogate/],
    [`cafe${char(0x301)}.md`, /NFC/],
    [`zwj/${char(0x1f469)}${char(0x200d)}${char(0x1f4bb)}.png`, /invisible/],
    ["-rf", /starts with "-"/],
    ["a/-n", /starts with "-"/],
    ["trailing ", /ends with a space or a dot/],
    ["trailing.", /ends with a space or a dot/],
    [".git/config", /cannot go into \.git/],
    [".GIT/hooks/pre-commit", /cannot go into \.GIT/],
    [".jj/repo", /cannot go into \.jj/],
    [".jj-bot/skills/x/SKILL.md", /cannot go into \.jj-bot/],
    [`${"a/".repeat(8)}b`, /more than 8 parts/],
    [`${"x".repeat(256)}`, /longer than 255 bytes/],
    [char(0xe9).repeat(128), /longer than 255 bytes/],
    [`${"a".repeat(200)}/`.repeat(6).slice(0, 1025), /longer than 1024/],
  ])("refuses %j", (path, problem) => {
    expect(uploadPathProblem(path)).toMatch(problem);
  });

  it("checks a staged name as one segment whose default path is valid", () => {
    expect(uploadNameProblem("report.pdf")).toBeUndefined();
    expect(uploadNameProblem(".git")).toBeUndefined();
    expect(uploadNameProblem("a/b")).toBe("The name holds a /.");
    expect(uploadNameProblem("..")).toBe("The name is . or ..");
    expect(uploadNameProblem("")).toBe("The name is empty.");
    expect(uploadNameProblem("x".repeat(256))).toMatch(/longer than 255/);
  });
});

describe("upload commands", () => {
  it("defaults a task's uploads to none, refuses reuse and paths that clash ignoring case", () => {
    expect(
      createTaskCommandSchema.parse({ goal: "g", coordinatorBotId: "bot_1" })
        .uploads,
    ).toEqual([]);
    const twice = uploadToTaskCommandSchema.safeParse({
      files: [{ uploadId: "upl_1" }, { uploadId: "upl_1" }],
    });
    expect(twice.success).toBe(false);
    const clash = uploadToTaskCommandSchema.safeParse({
      files: [
        { uploadId: "upl_1", path: "a/B.csv" },
        { uploadId: "upl_2", path: "A/b.csv" },
      ],
    });
    expect(clash.success).toBe(false);
    expect(uploadToTaskCommandSchema.safeParse({ files: [] }).success).toBe(
      false,
    );
    const many = Array.from({ length: 21 }, (_, index) => ({
      uploadId: `upl_${index}`,
    }));
    expect(uploadToTaskCommandSchema.safeParse({ files: many }).success).toBe(
      false,
    );
    expect(
      uploadToTaskCommandSchema.safeParse({
        files: [{ uploadId: "upl_1", path: "../escape" }],
      }).success,
    ).toBe(false);
  });

  it("gives a template no files, and a start its uploads", () => {
    const template = createTaskTemplateCommandSchema.parse({
      title: "t",
      goal: "g",
      coordinatorBotId: "bot_1",
      uploads: [{ uploadId: "upl_1" }],
    });
    expect("uploads" in template).toBe(false);
    const start = startTemplateCommandSchema.parse({
      uploads: [{ uploadId: "upl_1", path: "in/a.csv" }],
    });
    expect(
      templateTaskCommand(
        {
          title: "t",
          goal: "g",
          coordinatorBotId: "bot_1",
          participantBotIds: ["bot_1"],
          verificationPlan: null,
        },
        start,
      ).uploads,
    ).toEqual([{ uploadId: "upl_1", path: "in/a.csv" }]);
    expect(startTemplateCommandSchema.parse({}).uploads).toEqual([]);
  });

  it("parses records and capabilities from servers before uploads", () => {
    const artifact = artifactSchema.parse({
      id: "art_1",
      taskId: "task_1",
      sessionId: null,
      runId: null,
      kind: "file",
      path: "a.txt",
      name: "a.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      createdAt: "2026-11-03T00:00:00.000Z",
    });
    expect(artifact.upload).toBeNull();
    expect(
      capabilitiesSchema.parse({
        agentExecution: true,
        persistence: true,
        streaming: true,
        verification: true,
        drivers: [],
      }).uploads,
    ).toBeNull();
    expect(
      stagedUploadSchema.safeParse({
        id: "upl_1",
        name: "a",
        sizeBytes: 1,
        sha256: "x",
        contentType: "text/plain",
        expiresAt: "2026-11-03T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("words sizes and announcements", () => {
    expect(formatUploadSize(812)).toBe("812 B");
    expect(formatUploadSize(1023)).toBe("1023 B");
    expect(formatUploadSize(1200)).toBe("1.2 KB");
    expect(formatUploadSize(1_234_567)).toBe("1.2 MB");
    expect(formatUploadSize(16 * 1024 * 1024)).toBe("16 MB");
    expect(formatUploadSize(250_000)).toBe("244.1 KB");
    expect(formatUploadSize(3 * 1024 ** 3)).toBe("3 GB");
    expect(
      uploadAnnouncement([
        { path: "uploads/a.csv", sizeBytes: 1_258_291 },
        { path: "uploads/b.txt", sizeBytes: 3072 },
      ]),
    ).toBe("Uploaded 2 files: uploads/a.csv (1.2 MB), uploads/b.txt (3 KB)");
  });
});

describe("artifact.updated", () => {
  it("folds onto the view like artifact.created", () => {
    const base = {
      id: "upl_1",
      taskId: "task_1",
      sessionId: null,
      runId: null,
      kind: "file" as const,
      path: "uploads/a.csv",
      name: "a.csv",
      contentType: "text/csv; charset=utf-8",
      sizeBytes: 3,
      sha256: "a".repeat(64),
      createdAt: "2026-11-03T00:00:00.000Z",
    };
    const pending = {
      ...base,
      upload: {
        messageId: "msg_1",
        state: "pending" as const,
        placedAt: null,
        error: null,
      },
    };
    const view = {
      task: {},
      sessions: [],
      messages: [],
      artifacts: [pending],
      approvals: [],
      verificationChecks: [],
      usage: { total: {}, bySession: {} },
      events: [],
      firstSequence: 1,
      hasEarlier: false,
      cursor: 4,
    } as unknown as TaskView;
    const placed = {
      ...pending,
      upload: {
        ...pending.upload,
        state: "placed" as const,
        placedAt: "2026-11-03T00:00:01.000Z",
      },
    };
    const event: TaskEvent = {
      id: "evt_5",
      taskId: "task_1",
      sequence: 5,
      occurredAt: "2026-11-03T00:00:01.000Z",
      botId: null,
      sessionId: null,
      runId: null,
      causedBy: null,
      type: "artifact.updated",
      payload: { artifact: placed, previousState: "pending" },
    };
    const next = applyTaskEvent(view, event);
    expect(next.artifacts).toEqual([placed]);
    expect(next.cursor).toBe(5);
  });
});
