/**
 * The engine's answer before a model call (`RunHooks.admitModelCall`):
 * undefined lets it go; a string refuses it (a spend cap was reached); and
 * `{ hold }` holds it: the call waits for the user's approval, which the
 * engine recorded, and the run ends `held` without making it.
 */
export type ModelCallAdmission = string | { hold: string } | undefined;

/**
 * Asks the engine before each model call of a run or chat reply (see
 * `RunHooks.admitModelCall`) and remembers the first refusal or hold: once a
 * call is refused or held, every later call of the same run is too, without
 * asking again.
 */
export class ModelCallGate {
  /** Why a call was refused or held, once one was. */
  refusal: string | undefined;
  /** True when that call was held for the user's approval, not refused. */
  held = false;

  constructor(private readonly check?: () => Promise<ModelCallAdmission>) {}

  /** True when the call may go ahead. A rejection of the check propagates. */
  async admit(): Promise<boolean> {
    if (this.refusal !== undefined) return false;
    const answer = await this.check?.();
    if (answer === undefined) return true;
    if (typeof answer === "object") {
      this.held = true;
      this.refusal =
        answer.hold.trim() || "The model call waits for the user's approval.";
      return false;
    }
    this.refusal = answer.trim() || "A spend cap was reached.";
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
