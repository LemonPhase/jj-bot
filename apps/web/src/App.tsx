import { lazy, Suspense } from "react";
import { AppShell } from "./features/shell/AppShell";

// Dev-only kit gallery at ?gallery=1. `import.meta.env.DEV` is false in
// production builds, so the gallery is neither bundled nor reachable there.
const Gallery = import.meta.env.DEV
  ? lazy(() => import("./dev/Gallery").then((m) => ({ default: m.Gallery })))
  : null;
const showGallery =
  Gallery !== null &&
  new URLSearchParams(window.location.search).has("gallery");

/** The theme comes from `useTheme()` (src/lib/theme.ts), applied before first render. */
export function App() {
  if (Gallery && showGallery)
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  return <AppShell />;
}
