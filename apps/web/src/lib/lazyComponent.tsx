import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  useState,
} from "react";
import { restoreStylesheets } from "./stylesheets";

/** A component in a chunk of its own, with one import for its preload and its render. */
export interface LazyComponent<P extends object> {
  /** The component; it suspends while its chunk loads. */
  Component: ComponentType<P>;
  /**
   * Starts loading the chunk on the first call; later calls share that load,
   * a failed one included (see `lazyComponent`).
   */
  load: () => Promise<unknown>;
}

/**
 * A component in a chunk of its own (`import()`), for code only some visits
 * use: a screen, a dialog, a panel. Render it inside a `Suspense` boundary,
 * whose fallback shows while the chunk loads, and an error boundary for a
 * chunk that never arrives. Once its chunk is in it renders at once:
 * `React.lazy` suspends on its first render even then, which would flash the
 * fallback for as long as React holds one on screen (about 300 ms).
 *
 * A load that fails stays failed, so the boundary says so and offers a
 * reload. Trying again would not help, and could hurt: Chromium keeps a
 * failed dynamic import for the page's life, and Vite's preload helper never
 * asks again for a stylesheet it has tried, so a second try would render the
 * part without its CSS. For the same reason a load first asks again for the
 * stylesheets of its chunk that failed before (`restoreStylesheets`):
 * another part may share them. A background download that must not cost the
 * click its chance is a prefetch instead (`prefetchChunks` in
 * apps/web/prefetch.ts), which never runs the chunk.
 *
 * `name` is the file name of the module `importComponent` imports, without
 * its extension: the build lists each lazy chunk's stylesheets under it
 * (apps/web/chunkStylesheets.ts).
 */
export function lazyComponent<P extends object>(
  name: string,
  importComponent: () => Promise<ComponentType<P>>,
): LazyComponent<P> {
  let loading: Promise<ComponentType<P>> | undefined;
  let loaded: ComponentType<P> | undefined;
  const load = () => {
    loading ??= restoreStylesheets(name)
      .then(importComponent)
      .then((component) => {
        loaded = component;
        return component;
      });
    return loading;
  };
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  function Loaded(props: P) {
    // Chosen once per mount, so it never remounts when its chunk lands.
    const [Chosen] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Chosen {...props} />;
  }
  Loaded.displayName = name;
  return { Component: Loaded, load };
}

/**
 * How long a part asked for may take to load before it opens with its
 * placeholder. From the prefetch cache a chunk loads in tens of milliseconds.
 */
export const OPEN_WAIT_MS = 150;

/**
 * Calls `open` once `part` has loaded, or after `wait` ms, whichever comes
 * first, so a part already in the cache opens at once: opened before its
 * chunk is in, it would show its placeholder for as long as React holds a
 * Suspense fallback (about 300 ms). A slow load opens with the placeholder,
 * and a failed one opens with its boundary's error.
 */
export function openWhenLoaded(
  part: Pick<LazyComponent<never>, "load">,
  open: () => void,
  wait: number = OPEN_WAIT_MS,
): void {
  let opened = false;
  const once = () => {
    if (opened) return;
    opened = true;
    window.clearTimeout(timer);
    open();
  };
  const timer = window.setTimeout(once, wait);
  part.load().then(once, once);
}

/**
 * Shows `failed` instead of its children when they throw: a lazy part whose
 * chunk or stylesheet did not arrive (the connection dropped, or a redeploy
 * replaced it while the page was open) says so in place instead of
 * unmounting the app. Only a reload fetches it again.
 */
export class LoadBoundary extends Component<
  { children: ReactNode; failed: (error: Error) => ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { error } = this.state;
    return error ? this.props.failed(error) : this.props.children;
  }
}
