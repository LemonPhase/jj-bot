import { Button, Input, Select } from "../../components/ui";
import {
  type CheckDraft,
  type CheckExpect,
  type CheckMethod,
  emptyDraft,
} from "./verification";

const METHODS = [
  { value: "command", label: "Command exits 0" },
  { value: "file", label: "Workspace file" },
  { value: "result", label: "The result text" },
] as const satisfies readonly { value: CheckMethod; label: string }[];

const FILE_EXPECTS = [
  { value: "exists", label: "exists" },
  { value: "contains", label: "contains" },
  { value: "matches", label: "matches a regex" },
  { value: "json", label: "is valid JSON" },
] as const satisfies readonly { value: CheckExpect; label: string }[];

const RESULT_EXPECTS = FILE_EXPECTS.filter(
  (option) => option.value !== "exists",
);

/**
 * Edits a verification plan as rows of checks: what each checks, and how
 * (a command in the task's sandbox, an assertion on a workspace file or on
 * the result). The plan is the user's; the task completes only when every
 * check passes. JSON Schemas, regex flags and timeouts set through the API
 * are kept on a check whose kind is unchanged.
 */
export function ChecksEditor({
  drafts,
  onChange,
  errors,
  disabled,
}: {
  drafts: CheckDraft[];
  onChange: (drafts: CheckDraft[]) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  const update = (key: string, patch: Partial<CheckDraft>) =>
    onChange(
      drafts.map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft,
      ),
    );
  return (
    <div className="checks-editor">
      {drafts.length === 0 && (
        <p className="checks-editor__empty">
          No checks: the task completes when its coordinator delivers the
          result, and it is never shown as verified.
        </p>
      )}
      {drafts.map((draft, index) => {
        const label = `Check ${index + 1}`;
        const expects = draft.method === "file" ? FILE_EXPECTS : RESULT_EXPECTS;
        const expect =
          draft.method === "result" && draft.expect === "exists"
            ? "contains"
            : draft.expect;
        const needsValue = expect === "contains" || expect === "matches";
        return (
          <fieldset key={draft.key} className="checks-editor__row">
            <legend className="checks-editor__legend">
              {label}
              {draft.id ? ` · ${draft.id}` : ""}
            </legend>
            <Input
              label="What it checks"
              value={draft.description}
              placeholder="The tests pass"
              disabled={disabled}
              onChange={(event) =>
                update(draft.key, { description: event.target.value })
              }
            />
            <div className="checks-editor__how">
              <Select
                label="How"
                value={draft.method}
                options={METHODS}
                disabled={disabled}
                onChange={(method) => update(draft.key, { method })}
              />
              {draft.method === "command" ? (
                <Input
                  label="Command"
                  className="checks-editor__wide"
                  value={draft.command}
                  placeholder="npm test"
                  spellCheck={false}
                  disabled={disabled}
                  hint="Runs in the task's sandbox from the workspace root."
                  onChange={(event) =>
                    update(draft.key, { command: event.target.value })
                  }
                />
              ) : (
                <>
                  {draft.method === "file" && (
                    <Input
                      label="Path"
                      value={draft.path}
                      placeholder="README.md"
                      spellCheck={false}
                      disabled={disabled}
                      onChange={(event) =>
                        update(draft.key, { path: event.target.value })
                      }
                    />
                  )}
                  <Select
                    label="Expect"
                    value={expect}
                    options={expects}
                    disabled={disabled}
                    onChange={(value) => update(draft.key, { expect: value })}
                  />
                  {needsValue && (
                    <Input
                      label={expect === "matches" ? "Pattern" : "Text"}
                      value={draft.value}
                      spellCheck={false}
                      disabled={disabled}
                      onChange={(event) =>
                        update(draft.key, { value: event.target.value })
                      }
                    />
                  )}
                </>
              )}
            </div>
            {errors[draft.key] && (
              <p className="checks-editor__error" role="alert">
                {errors[draft.key]}
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="checks-editor__remove"
              disabled={disabled}
              aria-label={`Remove ${label.toLowerCase()}`}
              onClick={() =>
                onChange(drafts.filter((entry) => entry.key !== draft.key))
              }
            >
              Remove
            </Button>
          </fieldset>
        );
      })}
      <Button
        size="sm"
        disabled={disabled || drafts.length >= 20}
        onClick={() => onChange([...drafts, emptyDraft()])}
      >
        Add a check
      </Button>
    </div>
  );
}
