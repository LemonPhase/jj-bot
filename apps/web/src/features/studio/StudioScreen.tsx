import { Button, buttonClass, EmptyState } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { botHref } from "../shell/router";
import { BackLink, ScreenHeader } from "../shell/ScreenHeader";
import { useShell } from "../shell/ShellContext";

/**
 * `#/studio` (new bot) and `#/studio/:botId` (edit). Route stub: Bot Studio
 * (SPEC §5.6, §11) replaces this screen. Until then new bots come from the
 * name-and-role dialog.
 */
export function StudioScreen({ botId }: { botId: string | null }) {
  const { getBot } = useWorkspace();
  const { openNewBot } = useShell();
  const bot = botId ? getBot(botId) : undefined;
  const back = botHref(bot?.id ?? null);

  return (
    <main className="screen">
      <ScreenHeader
        lead={
          <>
            <BackLink href={back}>Bots</BackLink>
            <h1 className="screen-title">
              {bot ? `Edit ${bot.name}` : "Design a bot"}
            </h1>
          </>
        }
      />
      <div className="screen-body screen-body--center">
        <EmptyState
          align="center"
          message="Bot Studio is not available yet."
          action={
            bot ? (
              <a className={buttonClass({ variant: "primary" })} href={back}>
                Back to {bot.name}
              </a>
            ) : (
              <Button variant="primary" onClick={openNewBot}>
                New bot
              </Button>
            )
          }
        />
      </div>
    </main>
  );
}
