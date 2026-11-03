/**
 * Asks the engine before each model call of a run or chat reply (see
 * `RunHooks.admitModelCall`) and remembers the first refusal: once a call is
 * refused, every later call of the same run is refused without asking again.
 */
export class ModelCallGate {
  /** Why a call was refused, once one was. */
  refusal: string | undefined;

  constructor(private readonly check?: () => Promise<string | undefined>) {}

  /** True when the call may go ahead. A rejection of the check propagates. */
  async admit(): Promise<boolean> {
    if (this.refusal !== undefined) return false;
    const refusal = await this.check?.();
    if (refusal === undefined) return true;
    this.refusal = refusal.trim() || "A spend cap was reached.";
    return false;
  }
}

/** Thrown inside a stream function for a call the gate refused, so the caller never sends it. */
export class ModelCallRefusedError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = "ModelCallRefusedError";
  }
}
