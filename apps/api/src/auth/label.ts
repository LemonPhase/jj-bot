// A signed-in device's label, from its User-Agent: the browser and the
// system, such as "Safari on iPhone", so the device list can be told apart.
// Only a hint: a client can send any User-Agent.
import { AUTH_SESSION_LABEL_LIMIT } from "@jj/contracts";

const BROWSERS: [RegExp, string][] = [
  [/\bEdgA?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|Chrome\/|\bChromium\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/^curl\//, "curl"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

export function deviceLabel(userAgent: string | undefined): string {
  const agent = (userAgent ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  const label =
    browser && system
      ? `${browser} on ${system}`
      : (browser ?? (system ? `A browser on ${system}` : "Unknown device"));
  return label.slice(0, AUTH_SESSION_LABEL_LIMIT);
}
