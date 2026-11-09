import type { PGliteOptions } from "@electric-sql/pglite";

/** PostgreSQL's type id for bytea. */
const BYTEA = 17;

/**
 * Binary values to and from PGlite without its own bytea codec, which maps
 * every byte through JavaScript arrays and strings: a 16 MiB value held the
 * event loop for seconds, and 64 MiB ran the heap out. A value is sent as it
 * is, as a binary-format parameter (PGlite binds a byte view in binary, so
 * the server copies it as it is), and a result's hex text is decoded with
 * Node's native codec. Every PGlite this package opens uses these, so every
 * bytea column (artifacts, staged uploads, secrets) is read and written this
 * way. node-postgres already encodes a Buffer natively.
 */
export const PGLITE_TYPE_OPTIONS = {
  serializers: {
    [BYTEA]: ((value: unknown) => {
      if (!(value instanceof Uint8Array))
        throw new Error("Invalid input for bytea type");
      return value;
    }) as unknown as (value: unknown) => string,
  },
  parsers: {
    [BYTEA]: (text: string) => {
      const bytes = Buffer.from(
        text.startsWith("\\x") ? text.slice(2) : text,
        "hex",
      );
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
  },
} satisfies Pick<PGliteOptions, "parsers" | "serializers">;
