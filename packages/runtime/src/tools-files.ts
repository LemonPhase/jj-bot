import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { Sandbox } from "@jj/sandbox";
import {
  finalizeResult,
  guarded,
  type OutputPolicy,
  type SandboxToolOptions,
  workspacePath,
} from "./tools";

/**
 * read, edit and write on the sandbox fs API only. pi's versions resolve the
 * agent's path on the host first (read probes name variants with `access()`,
 * edit and write take a `realpath()` lock key), so a host file at the same
 * absolute path could change which sandbox file they touch. Here paths are
 * resolved lexically inside the workspace and the sandbox checks containment.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Serializes mutations of one workspace path; the key is the lexical path. */
const pathLocks = new Map<string, Promise<void>>();
async function withPathLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  pathLocks.set(key, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (pathLocks.get(key) === chained) pathLocks.delete(key);
  }
}

function sniffImage(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

const text = (value: string) => ({ type: "text" as const, text: value });

async function readFileInSandbox(
  sandbox: Sandbox,
  path: string,
): Promise<Buffer> {
  const info = await sandbox.fs.stat(path);
  if (!info) throw new Error(`File not found: ${path}`);
  if (info.kind === "directory")
    throw new Error(`${path} is a directory; use ls to list it.`);
  return sandbox.fs.read(path);
}

function readTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  return {
    name: "read",
    label: "read",
    description: `Read a file in the workspace. Text output is limited to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024} KB; use offset and limit for large files. Images (png, jpeg, gif, webp) are returned as attachments.`,
    parameters: Type.Object({
      path: Type.String({
        description:
          "File path, relative to the workspace or absolute inside it",
      }),
      offset: Type.Optional(
        Type.Number({ description: "Line to start at (1-indexed)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Most lines to read" })),
    }),
    async execute(_toolCallId, params) {
      const args = params as { path: string; offset?: number; limit?: number };
      const path = workspacePath(sandbox, args.path);
      const buffer = await guarded(options, () =>
        readFileInSandbox(sandbox, path),
      );
      const label = `read: ${args.path.slice(0, 120)}`;
      const mime = sniffImage(buffer);
      if (mime)
        return finalizeResult(
          buffer.length > MAX_IMAGE_BYTES
            ? {
                content: [
                  text(
                    `Image ${args.path} [${mime}] is ${formatSize(buffer.length)}, over the ${formatSize(MAX_IMAGE_BYTES)} limit.`,
                  ),
                ],
                details: undefined,
              }
            : {
                content: [
                  text(`Read image file [${mime}]`),
                  {
                    type: "image",
                    data: buffer.toString("base64"),
                    mimeType: mime,
                  },
                ],
                details: undefined,
              },
          policy,
          label,
        );
      const lines = buffer.toString("utf8").split("\n");
      const start =
        args.offset && args.offset > 0 ? Math.floor(args.offset) - 1 : 0;
      if (start >= lines.length)
        throw new Error(
          `Offset ${args.offset} is beyond the end of the file (${lines.length} lines).`,
        );
      const end =
        args.limit && args.limit > 0
          ? Math.min(lines.length, start + Math.floor(args.limit))
          : lines.length;
      const truncation = truncateHead(lines.slice(start, end).join("\n"));
      let output = truncation.content;
      if (truncation.firstLineExceedsLimit)
        output = `[Line ${start + 1} is over ${formatSize(DEFAULT_MAX_BYTES)}. Use bash, for example: sed -n '${start + 1}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
      else if (truncation.truncated) {
        const last = start + truncation.outputLines;
        output += `\n\n[Showing lines ${start + 1}-${last} of ${lines.length}. Use offset=${last + 1} to continue.]`;
      } else if (end < lines.length)
        output += `\n\n[${lines.length - end} more lines in the file. Use offset=${end + 1} to continue.]`;
      return finalizeResult(
        { content: [text(output)], details: undefined },
        policy,
        label,
      );
    },
  };
}

interface Edit {
  oldText: string;
  newText: string;
}

/** Accepts `edits` as a JSON string, a single edit, or legacy top-level oldText/newText. */
function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const args = { ...(input as Record<string, unknown>) };
  const isEdit = (value: unknown): value is Edit =>
    !!value &&
    typeof value === "object" &&
    typeof (value as Edit).oldText === "string" &&
    typeof (value as Edit).newText === "string";
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      args.edits = Array.isArray(parsed)
        ? parsed
        : isEdit(parsed)
          ? [parsed]
          : args.edits;
    } catch {
      // Left for validation to reject.
    }
  } else if (isEdit(args.edits)) args.edits = [args.edits];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    edits.push({ oldText: args.oldText, newText: args.newText });
    delete args.oldText;
    delete args.newText;
    args.edits = edits;
  }
  return args;
}

/** Applies exact, unique, non-overlapping replacements to LF-normalized text. */
export function applyEdits(
  content: string,
  edits: readonly Edit[],
  path: string,
): string {
  const ranges = edits.map((edit, index) => {
    const oldText = edit.oldText.replace(/\r\n/g, "\n");
    if (oldText.length === 0)
      throw new Error(`Edit ${index + 1} for ${path} has an empty oldText.`);
    const at = content.indexOf(oldText);
    if (at < 0)
      throw new Error(
        `Edit ${index + 1}: the text to replace was not found in ${path}. It must match the file exactly, including whitespace.`,
      );
    if (content.indexOf(oldText, at + 1) >= 0)
      throw new Error(
        `Edit ${index + 1}: the text to replace appears more than once in ${path}; include more surrounding lines to make it unique.`,
      );
    return {
      start: at,
      end: at + oldText.length,
      newText: edit.newText.replace(/\r\n/g, "\n"),
      index,
    };
  });
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1];
    const after = sorted[i];
    if (before && after && after.start < before.end)
      throw new Error(
        `Edits ${before.index + 1} and ${after.index + 1} overlap in ${path}; merge them into one edit.`,
      );
  }
  let result = content;
  for (const range of [...sorted].reverse())
    result =
      result.slice(0, range.start) + range.newText + result.slice(range.end);
  return result;
}

function editTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  const edit = Type.Object({
    oldText: Type.String({
      description:
        "Exact text to replace. It must be unique in the original file and not overlap other edits.",
    }),
    newText: Type.String({ description: "Replacement text." }),
  });
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit one file with exact text replacements. Every edits[].oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "File path, relative to the workspace or absolute inside it",
      }),
      edits: Type.Array(edit, {
        description:
          "One or more replacements, each matched against the original file.",
      }),
    }),
    prepareArguments: prepareEditArguments as never,
    async execute(_toolCallId, params) {
      const args = params as { path: string; edits: Edit[] };
      if (!Array.isArray(args.edits) || args.edits.length === 0)
        throw new Error("edits must contain at least one replacement.");
      const path = workspacePath(sandbox, args.path);
      return withPathLock(path, async () => {
        const raw = (
          await guarded(options, () => readFileInSandbox(sandbox, path))
        ).toString("utf8");
        const bom = raw.startsWith("﻿") ? "﻿" : "";
        const body = bom ? raw.slice(1) : raw;
        const crlf = body.includes("\r\n");
        const updated = applyEdits(
          body.replace(/\r\n/g, "\n"),
          args.edits,
          args.path,
        );
        const final = bom + (crlf ? updated.replace(/\n/g, "\r\n") : updated);
        await guarded(options, () => sandbox.fs.write(path, final));
        return finalizeResult(
          {
            content: [
              text(
                `Successfully replaced ${args.edits.length} block(s) in ${args.path}.`,
              ),
            ],
            details: undefined,
          },
          policy,
          `edit: ${args.path.slice(0, 120)}`,
        );
      });
    },
  };
}

function writeTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  return {
    name: "write",
    label: "write",
    description:
      "Write a file in the workspace, creating it and its parent directories, or overwriting it.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "File path, relative to the workspace or absolute inside it",
      }),
      content: Type.String({ description: "The whole file content" }),
    }),
    async execute(_toolCallId, params) {
      const args = params as { path: string; content: string };
      const path = workspacePath(sandbox, args.path);
      await withPathLock(path, () =>
        guarded(options, () => sandbox.fs.write(path, args.content)),
      );
      return finalizeResult(
        {
          content: [
            text(
              `Successfully wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}.`,
            ),
          ],
          details: undefined,
        },
        policy,
        `write: ${args.path.slice(0, 120)}`,
      );
    },
  };
}

export const fileTools = { read: readTool, edit: editTool, write: writeTool };
