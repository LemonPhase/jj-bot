import { defaultAppearanceFor } from "@jj/contracts";
import { type FormEvent, useId, useMemo, useState } from "react";
import { PixelSprite } from "../../components/sprite";
import { Button, Dialog, ErrorBanner, Input } from "../../components/ui";
import { appearanceSummary } from "../../lib/appearance";
import { useWorkspace } from "../../state/WorkspaceContext";
import "./bots.css";

/**
 * The new-bot flow until Bot Studio exists: a name and a role. The look is
 * `defaultAppearanceFor(name)` (brief decision 4), previewed as it is typed.
 * On success the workspace opens the new bot.
 */
export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const { createBot } = useWorkspace();
  const formId = useId();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const appearance = useMemo(
    () => defaultAppearanceFor(trimmed || "New bot"),
    [trimmed],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBot({
        name: trimmed,
        role: role.trim(),
        appearance: defaultAppearanceFor(trimmed),
      });
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not create the bot.",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="New bot"
      description="Its look comes from its name."
      dismissible={!trimmed && !role.trim()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={!trimmed || busy}
          >
            {busy ? "Creating…" : "Create bot"}
          </Button>
        </>
      }
    >
      <form id={formId} className="new-bot-form" onSubmit={submit}>
        <div className="new-bot-form__preview">
          <PixelSprite appearance={appearance} size={60} />
          <span className="new-bot-form__summary">
            {appearanceSummary(appearance)}
          </span>
        </div>
        <Input
          label="Name"
          value={name}
          maxLength={60}
          autoComplete="off"
          placeholder="e.g. Nova"
          required
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label="Role"
          value={role}
          maxLength={80}
          autoComplete="off"
          placeholder="e.g. Security review"
          hint="Optional. Shown next to the name."
          onChange={(event) => setRole(event.target.value)}
        />
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </form>
    </Dialog>
  );
}
