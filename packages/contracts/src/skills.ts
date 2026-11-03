import { z } from "zod";
import { timestampSchema } from "./common";

/**
 * Skills: Agent Skills folders (a `SKILL.md` with `name` and `description`
 * frontmatter, plus the files it uses) kept in the server's library. A
 * runtime profile grants them by name (`profile.skills`), the way it grants
 * sandbox secrets. Each upload is a content-addressed version (`hash`).
 */

/** Most skills one profile grants. */
export const MAX_PROFILE_SKILLS = 32;
/** Most files one skill holds. */
export const MAX_SKILL_FILES = 100;
/** Largest skill, in decoded bytes over all its files. */
export const MAX_SKILL_BYTES = 1_048_576;
/** Largest `SKILL.md`, in bytes. */
export const MAX_SKILL_MD_BYTES = 65_536;
/** Longest skill description, as the Agent Skills format bounds it. */
export const SKILL_DESCRIPTION_LIMIT = 1_024;
/** Most path segments of a skill file. */
export const MAX_SKILL_PATH_SEGMENTS = 8;
/** The file every skill has at its root. */
export const SKILL_MD = "SKILL.md";

/** Lowercase letters and digits in hyphen-separated words, at most 64 characters (the Agent Skills format). */
export const skillNameSchema = z
  .string()
  .max(64, "Use at most 64 characters.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters and digits, with single hyphens between them.",
  );

/** The skills a runtime profile grants, by name. */
export const skillGrantsSchema = z
  .array(skillNameSchema)
  .max(MAX_PROFILE_SKILLS, `Grant at most ${MAX_PROFILE_SKILLS} skills.`)
  .refine((names) => new Set(names).size === names.length, {
    message: "Skills must be unique.",
  });

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A file's path within its skill: relative POSIX segments of letters,
 * digits, `.`, `_` and `-`, never `.` or `..`, at most
 * MAX_SKILL_PATH_SEGMENTS of them. No absolute path, backslash or NUL.
 */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (path) => {
      const segments = path.split("/");
      return (
        segments.length <= MAX_SKILL_PATH_SEGMENTS &&
        segments.every(
          (segment) =>
            SEGMENT.test(segment) && segment !== "." && segment !== "..",
        )
      );
    },
    {
      message: `Use a relative path of at most ${MAX_SKILL_PATH_SEGMENTS} parts of letters, digits, ".", "_" and "-", without "." or ".." parts.`,
    },
  );

/** Bytes a base64 text decodes to. */
export function base64DecodedBytes(text: string): number {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

/**
 * `PUT /api/skills/:name` → `{ skill }`, 201 when new and 200 when
 * replaced. A whole folder, as data: no archive. The server also parses
 * `SKILL.md`'s frontmatter, which needs a description.
 */
export const putSkillCommandSchema = z.object({
  files: z
    .array(
      z.object({
        path: skillFilePathSchema,
        contentBase64: z.base64(),
        executable: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(MAX_SKILL_FILES, `Use at most ${MAX_SKILL_FILES} files.`)
    .superRefine((files, context) => {
      const paths = new Set(files.map((file) => file.path));
      files.forEach((file, index) => {
        if (files.findIndex((other) => other.path === file.path) !== index)
          context.addIssue({
            code: "custom",
            path: [index, "path"],
            message: `${file.path} is listed more than once.`,
          });
        const parts = file.path.split("/");
        for (let end = 1; end < parts.length; end += 1) {
          const folder = parts.slice(0, end).join("/");
          if (paths.has(folder))
            context.addIssue({
              code: "custom",
              path: [index, "path"],
              message: `${folder} is a file, so it cannot hold ${file.path}.`,
            });
        }
      });
      const skillMd = files.find((file) => file.path === SKILL_MD);
      if (!skillMd)
        context.addIssue({
          code: "custom",
          path: [],
          message: `A skill needs a ${SKILL_MD} at its root.`,
        });
      else if (base64DecodedBytes(skillMd.contentBase64) > MAX_SKILL_MD_BYTES)
        context.addIssue({
          code: "custom",
          path: [files.indexOf(skillMd), "contentBase64"],
          message: `${SKILL_MD} may hold at most ${MAX_SKILL_MD_BYTES} bytes.`,
        });
      const bytes = files.reduce(
        (total, file) => total + base64DecodedBytes(file.contentBase64),
        0,
      );
      if (bytes > MAX_SKILL_BYTES)
        context.addIssue({
          code: "custom",
          path: [],
          message: `A skill may hold at most ${MAX_SKILL_BYTES} bytes.`,
        });
    }),
});

/** A skill in the library: its current version and what it holds. */
export const skillSchema = z.object({
  name: skillNameSchema,
  /** From `SKILL.md`'s frontmatter; what the prompt lists. */
  description: z.string().max(SKILL_DESCRIPTION_LIMIT),
  /** SHA-256 of the version's files: a new upload with other content is a new version. */
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(
    z.object({
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
      executable: z.boolean(),
    }),
  ),
  /** Decoded size of every file together. */
  bytes: z.number().int().nonnegative(),
  /** What the upload holds that JJ Bot does not honour, such as `allowed-tools`. */
  warnings: z.array(z.string()),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** `GET /api/skills`. */
export const skillsViewSchema = z.object({ skills: z.array(skillSchema) });

/** `GET /api/skills/:name` and `PUT /api/skills/:name`. `DELETE` answers 204 and removes the skill's grants in the same transaction. */
export const skillResultSchema = z.object({ skill: skillSchema });

export type SkillName = z.infer<typeof skillNameSchema>;
export type PutSkillCommand = z.input<typeof putSkillCommandSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type SkillsView = z.infer<typeof skillsViewSchema>;
export type SkillResult = z.infer<typeof skillResultSchema>;
