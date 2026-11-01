import type { Bot } from "@jj/contracts";
import {
  type FormEvent,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import { isApiError } from "../../api/client";
import {
  Button,
  buttonClass,
  EmptyState,
  ErrorBanner,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { useModels } from "../bots/useModels";
import { botHref } from "../shell/router";
import { BackLink, ScreenHeader } from "../shell/ScreenHeader";
import { navigate, previousRoute } from "../shell/useRoute";
import { PartPickers } from "./PartPickers";
import type { PreviewMotion } from "./PixelFigure";
import { StudioDetails } from "./StudioDetails";
import { StudioPreview } from "./StudioPreview";
import {
  createBotCommand,
  type DraftErrors,
  draftErrors,
  draftFromBot,
  exitRoute,
  newBotDraft,
  serverFieldErrors,
  studioReducer,
  type TextField,
  updateBotCommand,
} from "./studioDraft";
import "./studio.css";

/** `#/studio/new` designs a new bot; `#/studio/:botId` edits one (SPEC §5.6, §11). */
export function StudioScreen({ botId }: { botId: string | null }) {
  const { getBot } = useWorkspace();
  if (botId === null) return <Studio key="new" bot={null} />;
  const bot = getBot(botId);
  if (!bot)
    return (
      <main className="screen screen--center">
        <EmptyState
          align="center"
          message="This bot does not exist or was archived."
          action={
            <a
              className={buttonClass({ variant: "primary" })}
              href={botHref(null)}
            >
              Back to bots
            </a>
          }
        />
      </main>
    );
  return <Studio key={bot.id} bot={bot} />;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; code: string; message: string };

const FIELD_ORDER: readonly TextField[] = ["name", "role", "instructions"];

function Studio({ bot }: { bot: Bot | null }) {
  const { createBot, updateBot, profiles } = useWorkspace();
  const { models, error: modelsError } = useModels();
  const [draft, dispatch] = useReducer(studioReducer, bot, (initial) =>
    initial ? draftFromBot(initial) : newBotDraft(),
  );
  const [motion, setMotion] = useState<PreviewMotion>("walk");
  const [submitted, setSubmitted] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [serverErrors, setServerErrors] = useState<DraftErrors>({});
  const formId = useId();
  const fieldId = useId();
  const ids = {
    name: `${fieldId}-name`,
    role: `${fieldId}-role`,
    instructions: `${fieldId}-instructions`,
  };

  const clientErrors = draftErrors(draft);
  const errors: DraftErrors = {
    ...(submitted ? clientErrors : {}),
    ...serverErrors,
  };
  const update = bot ? updateBotCommand(bot, draft) : null;
  const dirty = bot ? update !== null : true;
  const busy = save.kind === "busy";

  // While nothing is edited here, follow changes saved elsewhere.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const updatedAt = bot?.updatedAt;
  useEffect(() => {
    if (bot && !dirtyRef.current)
      dispatch({ type: "reset", draft: draftFromBot(bot) });
    // `updatedAt` stands for every stored field of the bot.
  }, [updatedAt]);

  const leave = () => navigate(exitRoute(previousRoute(), bot?.id ?? null));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    const invalid = FIELD_ORDER.find((field) => clientErrors[field]);
    if (invalid) {
      document.getElementById(ids[invalid])?.focus();
      return;
    }
    if (bot && !update) return;
    setSave({ kind: "busy" });
    setServerErrors({});
    try {
      if (bot && update) {
        await updateBot(bot.id, update);
        leave();
      } else {
        // Opens the new bot's chat.
        await createBot(createBotCommand(draft));
      }
    } catch (reason) {
      const code = isApiError(reason) ? reason.code : "Error";
      const message =
        reason instanceof Error ? reason.message : "The bot was not saved.";
      setSave({ kind: "error", code, message });
      if (isApiError(reason) && reason.code === "VALIDATION_FAILED")
        setServerErrors(serverFieldErrors(reason.details));
      else if (isApiError(reason) && reason.code === "CONFLICT")
        setServerErrors({ name: message });
    }
  };

  return (
    <main className="screen studio-screen">
      <ScreenHeader
        lead={
          <>
            <BackLink href={botHref(bot?.id ?? null)}>Bots</BackLink>
            <h1 className="screen-title">
              {bot ? `Edit ${bot.name}` : "Design a bot"}
            </h1>
            <span className="studio-subtitle">
              Every part brings its own motion.
            </span>
          </>
        }
        actions={
          <>
            <Button onClick={leave} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={busy || !dirty}
              title={dirty ? undefined : "No changes to save"}
            >
              {bot
                ? busy
                  ? "Saving…"
                  : "Save changes"
                : busy
                  ? "Creating…"
                  : "Create bot"}
            </Button>
          </>
        }
      />
      <form
        id={formId}
        className="studio-body"
        onSubmit={submit}
        noValidate
        aria-label={bot ? `Edit ${bot.name}` : "Design a bot"}
      >
        {save.kind === "error" && (
          <ErrorBanner
            className="studio-error"
            word={save.code}
            onDismiss={() => setSave({ kind: "idle" })}
          >
            {save.message}
          </ErrorBanner>
        )}
        <div className="studio-main">
          <StudioPreview
            appearance={draft.appearance}
            name={draft.name}
            motion={motion}
            onMotionChange={setMotion}
          />
          <StudioDetails
            draft={draft}
            errors={errors}
            ids={ids}
            models={models}
            modelsError={modelsError}
            profiles={profiles}
            current={{
              model: bot?.model ?? null,
              runtimeProfileId: bot?.runtimeProfileId ?? null,
            }}
            onField={(field, value) => {
              dispatch({ type: "field", field, value });
              if (field in serverErrors)
                setServerErrors((current) => {
                  const next = { ...current };
                  delete next[field as TextField];
                  return next;
                });
            }}
          />
        </div>
        <PartPickers
          appearance={draft.appearance}
          onPart={(part, value) => dispatch({ type: "part", part, value })}
          onPreset={(appearance) => dispatch({ type: "preset", appearance })}
        />
      </form>
    </main>
  );
}
