import type { ApiBadge } from "../../api/client";
import type { ModeBadgeKind } from "../../components/ui";

const KIND_BY_LABEL: Readonly<Record<ApiBadge["label"], ModeBadgeKind>> = {
  "Demo data": "demo",
  Live: "live",
  "No model configured": "no-model",
  "Scripted model": "scripted",
};

/**
 * The sidebar badge for the API in use. The kind comes from the API's own
 * badge, so "Live" shows only when the live backend answered; the tooltip
 * keeps the API's explanation (for demo, why the backend was not used).
 */
export function modeBadgeFor(badge: ApiBadge): {
  kind: ModeBadgeKind;
  title: string;
} {
  return { kind: KIND_BY_LABEL[badge.label], title: badge.title };
}
