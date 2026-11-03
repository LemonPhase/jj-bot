import { describe, expect, it } from "vitest";
import {
  base64DecodedBytes,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  putSkillCommandSchema,
  skillFilePathSchema,
  skillNameSchema,
  skillResultSchema,
  skillSchema,
  skillsViewSchema,
} from "./index";

const at = "2026-11-03T12:00:00.000Z";
const b64 = (text: string) => Buffer.from(text).toString("base64");
const file = (path: string, content = "x", executable?: boolean) => ({
  path,
  contentBase64: b64(content),
  ...(executable === undefined ? {} : { executable }),
});
const skillMd = file(
  "SKILL.md",
  "---\nname: pdf-tools\ndescription: Fill PDF forms.\n---\nUse scripts/fill.py.\n",
);
const put = (files: unknown[]) => putSkillCommandSchema.safeParse({ files });

describe("skills", () => {
  it("names skills as the Agent Skills format does", () => {
    for (const good of ["pdf", "pdf-tools", "a1-b2", "x".repeat(64)])
      expect(skillNameSchema.safeParse(good).success, good).toBe(true);
    for (const bad of [
      "",
      "PDF",
      "pdf_tools",
      "pdf tools",
      "-pdf",
      "pdf-",
      "pdf--tools",
      "x".repeat(65),
    ])
      expect(skillNameSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("takes only relative paths without . or .. parts", () => {
    for (const good of [
      "SKILL.md",
      "scripts/fill.py",
      "reference/forms.md",
      ".hidden/notes.txt",
      "a/b/c/d/e/f/g/h.txt",
    ])
      expect(skillFilePathSchema.safeParse(good).success, good).toBe(true);
    for (const bad of [
      "",
      "..",
      "../SKILL.md",
      "scripts/../../etc/passwd",
      ".",
      "./SKILL.md",
      "/etc/passwd",
      "C:\\skill\\SKILL.md",
      "scripts\\fill.py",
      "scripts/",
      "scripts//fill.py",
      "nul\u0000.md",
      "with space.md",
      "a/b/c/d/e/f/g/h/i.txt",
      "x".repeat(256),
    ])
      expect(
        skillFilePathSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });

  it("accepts a folder with a root SKILL.md, executables marked", () => {
    const parsed = putSkillCommandSchema.parse({
      files: [skillMd, file("scripts/fill.py", "print(1)", true)],
    });
    expect(parsed.files.map((entry) => entry.executable)).toEqual([
      false,
      true,
    ]);
  });

  it("refuses a folder that is not one skill", () => {
    expect(put([]).success).toBe(false);
    expect(put([file("README.md")]).success).toBe(false);
    expect(put([file("docs/SKILL.md")]).success).toBe(false);
    expect(put([skillMd, file("a.txt"), file("a.txt")]).success).toBe(false);
    // A path cannot be both a file and a folder.
    expect(
      put([skillMd, file("scripts"), file("scripts/run.sh")]).success,
    ).toBe(false);
    expect(
      put([skillMd, { path: "x.bin", contentBase64: "not base64!" }]).success,
    ).toBe(false);
    expect(put([skillMd, file("../escape.sh")]).success).toBe(false);
  });

  it("caps files, total size and SKILL.md", () => {
    const many = Array.from({ length: MAX_SKILL_FILES - 1 }, (_, index) =>
      file(`f${index}.txt`),
    );
    expect(put([skillMd, ...many]).success).toBe(true);
    expect(put([skillMd, ...many, file("one-more.txt")]).success).toBe(false);

    const half = "x".repeat(MAX_SKILL_BYTES / 2);
    const md = (bytes: number) => file("SKILL.md", "y".repeat(bytes));
    expect(
      put([md(10), file("a.bin", half), file("b.bin", half.slice(10))]).success,
    ).toBe(true);
    expect(
      put([md(10), file("a.bin", half), file("b.bin", half.slice(9))]).success,
    ).toBe(false);
    expect(put([md(MAX_SKILL_MD_BYTES)]).success).toBe(true);
    expect(put([md(MAX_SKILL_MD_BYTES + 1)]).success).toBe(false);
  });

  it("counts decoded base64 bytes", () => {
    for (const text of ["", "a", "ab", "abc", "abcd", "é€😀", "x".repeat(1001)])
      expect(base64DecodedBytes(b64(text)), text).toBe(Buffer.byteLength(text));
  });

  it("parses the library's records", () => {
    const skill = {
      name: "pdf-tools",
      description: "Fill PDF forms.",
      hash: "c".repeat(64),
      files: [
        { path: "SKILL.md", size: 120, executable: false },
        { path: "scripts/fill.py", size: 8, executable: true },
      ],
      bytes: 128,
      warnings: ["allowed-tools is not honoured."],
      createdAt: at,
      updatedAt: at,
    };
    expect(skillSchema.parse(skill)).toEqual(skill);
    expect(skillsViewSchema.parse({ skills: [skill] }).skills).toHaveLength(1);
    expect(skillResultSchema.parse({ skill }).skill.name).toBe("pdf-tools");
    expect(
      skillSchema.safeParse({ ...skill, description: "x".repeat(1025) })
        .success,
    ).toBe(false);
    expect(
      skillSchema.safeParse({ ...skill, hash: "C".repeat(64) }).success,
    ).toBe(false);
  });
});
