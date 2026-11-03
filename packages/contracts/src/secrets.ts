import { z } from "zod";
import { timestampSchema } from "./common";

/**
 * The secrets store: provider keys and named sandbox secrets entered through
 * settings and kept encrypted with the server's `JJ_SECRET_KEY`. Values are
 * write-only: no answer ever carries one, only its last four characters.
 */

/**
 * Shortest value the store accepts. The server redacts its secrets wherever
 * they appear in what a run persists, and a shorter value is too likely to be
 * an ordinary word to replace safely, so it is refused instead.
 */
export const MIN_SECRET_LENGTH = 16;
export const MAX_SECRET_LENGTH = 4096;

/** A sandbox secret's name: the environment variable commands see it as. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Names the sandbox, its shell or its egress proxy set, or that change how programs load. */
const RESERVED_SECRET_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "HOSTNAME",
  "IFS",
  "ENV",
  "BASH_ENV",
  "PS1",
  "PS4",
  "PROMPT_COMMAND",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
]);
const RESERVED_SECRET_PREFIXES = ["JJ_", "LD_", "DYLD_", "LC_", "BASH_FUNC_"];

/** True for names a sandbox secret may not take (`PATH`, `HTTPS_PROXY`, `JJ_*`, `LD_*`, …). */
export function isReservedSecretName(name: string): boolean {
  return (
    RESERVED_SECRET_NAMES.has(name) ||
    name.endsWith("_PROXY") ||
    RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export const secretNameSchema = z
  .string()
  .regex(
    SECRET_NAME_PATTERN,
    "Use an environment variable name: capital letters, digits and underscores, starting with a letter, at most 64 characters.",
  )
  .refine((name) => !isReservedSecretName(name), {
    message:
      "This name is reserved: the sandbox, its shell or its proxy sets it, or it changes how programs load.",
  });

/**
 * A secret value: one line, surrounding whitespace trimmed. Validation
 * messages never repeat the value.
 */
export const secretValueSchema = z
  .string()
  .trim()
  .min(
    MIN_SECRET_LENGTH,
    `Use at least ${MIN_SECRET_LENGTH} characters: a shorter value cannot be redacted safely.`,
  )
  .max(MAX_SECRET_LENGTH, `Use at most ${MAX_SECRET_LENGTH} characters.`)
  .regex(
    /^[^\u0000-\u001f\u007f]*$/,
    "Use one line without control characters.",
  );

/** `PUT /api/secrets/:name` and `PUT /api/models/providers/:providerId/key`. */
export const putSecretCommandSchema = z.object({ value: secretValueSchema });

/**
 * A stored value as clients see it. `readable` is false when the current
 * `JJ_SECRET_KEY` cannot decrypt it (the key changed or is not set): it is
 * then not used anywhere until it is stored again or removed.
 */
export const storedSecretSchema = z.object({
  /** The value's last four characters. */
  hint: z.string().max(4),
  readable: z.boolean(),
  updatedAt: timestampSchema,
});

/** A named sandbox secret. Runtime profiles grant it by name (`profile.secrets`). */
export const secretInfoSchema = storedSecretSchema.extend({
  name: z.string().min(1),
  createdAt: timestampSchema,
});

/** `GET /api/secrets`. `available`: values can be stored (`JJ_SECRET_KEY` is set). */
export const secretsViewSchema = z.object({
  available: z.boolean(),
  secrets: z.array(secretInfoSchema),
});

/** The sandbox secrets a runtime profile grants, by name. */
export const secretGrantsSchema = z
  .array(secretNameSchema)
  .max(64)
  .refine((names) => new Set(names).size === names.length, {
    message: "Secrets must be unique.",
  });

export type PutSecretCommand = z.input<typeof putSecretCommandSchema>;
export type StoredSecret = z.infer<typeof storedSecretSchema>;
export type SecretInfo = z.infer<typeof secretInfoSchema>;
export type SecretsView = z.infer<typeof secretsViewSchema>;
