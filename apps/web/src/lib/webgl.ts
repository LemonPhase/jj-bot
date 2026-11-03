let cached: boolean | undefined;

/**
 * Whether this browser can draw WebGL, which the 3D office needs. Asked once
 * per page with a throwaway canvas; false without the WebGL API at all, or
 * when the context is refused (disabled, a blocklisted GPU, no hardware
 * acceleration and no software fallback).
 */
export function supportsWebGL(): boolean {
  if (cached !== undefined) return cached;
  try {
    if (typeof WebGLRenderingContext === "undefined") {
      cached = false;
      return cached;
    }
    const canvas = document.createElement("canvas");
    const context = (canvas.getContext("webgl2") ??
      canvas.getContext("webgl")) as WebGLRenderingContext | null;
    cached = context !== null;
    // Hand the context back at once: browsers cap how many a page holds.
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}
