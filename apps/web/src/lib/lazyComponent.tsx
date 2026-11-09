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
 * part without its CSS. For the same reason a load first asks again for any
 * stylesheet that failed before (`restoreStylesheets`): another part may
 * share it. A background download that must not cost the click its chance is
 * a prefetch instead (`prefetchChunks` in apps/web/prefetch.ts), which never
 * runs the chunk.
 */
export function lazyComponent<P extends object>(
  name: string,
  importComponent: () => Promise<ComponentType<P>>,
): LazyComponent<P> {
  let loading: Promise<ComponentType<P>> | undefined;
  let loaded: ComponentType<P> | undefined;
  const load = () => {
    loading ??= restoreStylesheets()
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
