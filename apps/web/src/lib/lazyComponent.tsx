import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  useState,
} from "react";

/** A component in a chunk of its own, with one import for its preload and its render. */
export interface LazyComponent<P extends object> {
  /** The component; it suspends while its chunk loads. */
  Component: ComponentType<P>;
  /**
   * Starts loading the chunk on the first call; later calls share that load.
   * A load that fails is forgotten, so the next call tries again: a render
   * after a failed preload, or the render's own second try.
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
 */
export function lazyComponent<P extends object>(
  name: string,
  importComponent: () => Promise<ComponentType<P>>,
): LazyComponent<P> {
  let loading: Promise<ComponentType<P>> | undefined;
  let loaded: ComponentType<P> | undefined;
  const load = () => {
    loading ??= importComponent().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    return loading;
  };
  // A render tries a failed load once more before its boundary shows: a
  // preload in flight when the component is asked for may have hit a
  // passing network error.
  const Lazy = lazy(() =>
    load()
      .catch(() => load())
      .then((component) => ({ default: component })),
  );
  function Loaded(props: P) {
    // Chosen once per mount, so it never remounts when its chunk lands.
    const [Chosen] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Chosen {...props} />;
  }
  Loaded.displayName = name;
  return { Component: Loaded, load };
}

/**
 * Runs `task` once the browser is idle, or shortly after where it cannot
 * tell (Safari); returns a cancel. For downloads the first screen does not
 * wait for, such as the chunks of the dialogs it offers.
 */
export function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: 2000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 200);
  return () => window.clearTimeout(handle);
}

/**
 * Shows `failed` instead of its children when they throw: a lazy part whose
 * chunk did not arrive (the connection dropped, or a redeploy replaced it
 * while the page was open) says so in place instead of unmounting the app.
 * React keeps a failed import's rejection, so only a reload fetches it again.
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
