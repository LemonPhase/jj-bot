// Argument parsing shared by the engine's tools: models send loose JSON.

/** A non-blank string argument, trimmed; undefined otherwise. */
export const textArg = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
