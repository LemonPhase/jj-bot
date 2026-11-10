// The pieces of signing in that need no server: the password hash, trusted
// proxies, the cookie's name and flags, device labels, and the settings.
import { describe, expect, it } from "vitest";
import { ConfigError, loadServerConfig, servesWithoutToken } from "../config";
import { limitKey, normalizeAddress, parseTrustedProxies } from "./clients";
import {
  clearSessionCookie,
  readSessionCookie,
  sessionCookie,
  setSessionCookie,
} from "./cookie";
import { deviceLabel } from "./label";
import { loginLink } from "./link";
import {
  hashPassword,
  PasswordHashError,
  parsePasswordHash,
  verifyPassword,
} from "./password";

describe("the password hash", () => {
  it("is scrypt N=2^15, r=8, p=1 with a random salt, and checks only its password", async () => {
    const text = await hashPassword("correct horse battery staple");
    expect(text).toMatch(
      /^scrypt:ln=15,r=8,p=1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/,
    );
    expect(text).not.toContain("$");
    expect(await hashPassword("correct horse battery staple")).not.toBe(text);
    const hash = parsePasswordHash(text);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(
      true,
    );
    expect(await verifyPassword(hash, "correct horse battery stapl")).toBe(
      false,
    );
    // The same characters typed in another normalization form.
    const composed = await hashPassword("café au lait, s'il vous plaît");
    expect(
      await verifyPassword(
        parsePasswordHash(composed),
        "café au lait, s'il vous plaît",
      ),
    ).toBe(true);
  });

  it("refuses a malformed hash, or parameters weaker or costlier than it checks, without repeating it", () => {
    const salt = Buffer.alloc(16, 1).toString("base64url");
    const key = Buffer.alloc(32, 2).toString("base64url");
    for (const text of [
      "",
      "hunter2",
      `$scrypt$ln=15,r=8,p=1$${salt}$${key}`,
      `scrypt:ln=14,r=8,p=1:${salt}:${key}`,
      `scrypt:ln=20,r=8,p=1:${salt}:${key}`,
      `scrypt:ln=15,r=8,p=1:${Buffer.alloc(8).toString("base64url")}:${key}`,
      `scrypt:ln=15,r=8,p=1:${salt}:${Buffer.alloc(16).toString("base64url")}`,
    ]) {
      expect(() => parsePasswordHash(text), text).toThrow(PasswordHashError);
      try {
        parsePasswordHash(text);
      } catch (error) {
        if (text) expect((error as Error).message).not.toContain(text);
      }
    }
  });
});

describe("trusted proxies", () => {
  it("trusts loopback by default, CIDR ranges, addresses and this machine's subnets", () => {
    const loopback = parseTrustedProxies();
    expect(loopback.trusts("127.0.0.1")).toBe(true);
    expect(loopback.trusts("::ffff:127.0.0.1")).toBe(true);
    expect(loopback.trusts("::1")).toBe(true);
    expect(loopback.trusts("10.0.0.1")).toBe(false);
    expect(loopback.trusts("unknown")).toBe(false);
    const listed = parseTrustedProxies("10.1.0.0/16, 2001:db8::/32,192.0.2.7");
    expect(listed.trusts("10.1.200.3")).toBe(true);
    expect(listed.trusts("10.2.0.1")).toBe(false);
    expect(listed.trusts("2001:db8::5")).toBe(true);
    expect(listed.trusts("192.0.2.7")).toBe(true);
    expect(listed.trusts("192.0.2.8")).toBe(false);
    expect(listed.trusts("127.0.0.1")).toBe(false);
    const local = parseTrustedProxies("local-subnets", () => ({
      eth0: [
        {
          address: "172.18.0.3",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.18.0.3/16",
        },
      ],
    }));
    expect(local.trusts("172.18.0.9")).toBe(true);
    expect(local.trusts("172.19.0.9")).toBe(false);
    expect(parseTrustedProxies("none").trusts("127.0.0.1")).toBe(false);
    expect(normalizeAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  it("counts an IPv4 client by its address and an IPv6 client by its /64", () => {
    expect(limitKey("198.51.100.7")).toBe("198.51.100.7");
    expect(limitKey("unknown")).toBe("unknown");
    for (const address of [
      "2001:db8:1:2::1",
      "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff",
      "2001:db8:1:2:a:b:192.0.2.1",
      "2001:db8:1:2::5%eth0",
    ])
      expect(limitKey(address), address).toBe("2001:db8:1:2::/64");
    expect(limitKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(limitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limitKey("::1")).toBe("0:0:0:0::/64");
    expect(limitKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });

  it("refuses anything else", () => {
    for (const setting of ["proxy", "10.0.0.0/33", "10.0.0.1/8/1", "*"])
      expect(() => parseTrustedProxies(setting), setting).toThrow(
        /JJ_TRUSTED_PROXIES/,
      );
  });
});

describe("the cookie", () => {
  it("is __Host- and Secure only for an https public URL", () => {
    expect(sessionCookie("https://jj.example.com")).toEqual({
      name: "__Host-jj_session",
      secure: true,
    });
    for (const url of [
      undefined,
      "http://127.0.0.1:3001",
      "http://jj.lan:3001",
    ])
      expect(sessionCookie(url)).toEqual({ name: "jj_session", secure: false });
    const secure = sessionCookie("https://jj.example.com");
    expect(setSessionCookie(secure, "s".repeat(43), 90_500)).toBe(
      `__Host-jj_session=${"s".repeat(43)}; Path=/; Max-Age=90; HttpOnly; SameSite=Strict; Secure`,
    );
    expect(clearSessionCookie(secure)).toBe(
      "__Host-jj_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure",
    );
  });

  it("reads only its own name, with a well-formed value", () => {
    const plain = sessionCookie(undefined);
    const value = "A".repeat(43);
    expect(
      readSessionCookie(plain, `theme=dark; jj_session=${value}; other=1`),
    ).toBe(value);
    expect(readSessionCookie(plain, `xjj_session=${value}`)).toBeUndefined();
    expect(readSessionCookie(plain, "jj_session=a;b")).toBeUndefined();
    expect(readSessionCookie(plain, undefined)).toBeUndefined();
  });
});

describe("device labels and login links", () => {
  it("names the browser and the system", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ),
    ).toBe("Safari on macOS");
    expect(deviceLabel("curl/8.10.1")).toBe("curl");
    expect(deviceLabel(undefined)).toBe("Unknown device");
    expect(deviceLabel(`X\u0000${"y".repeat(200)} Linux`).length).toBe(
      "A browser on Linux".length,
    );
  });

  it("puts the code in the fragment, which no request carries", () => {
    const link = new URL(loginLink("https://jj.example.com/", "c0de"));
    expect(link.pathname).toBe("/");
    expect(link.search).toBe("");
    expect(link.hash).toBe("#/login?code=c0de");
  });
});

describe("sign-in settings", () => {
  it("reads JJ_PASSWORD_HASH, which asks for sign-in even on loopback", async () => {
    const text = await hashPassword("correct horse battery staple");
    const config = loadServerConfig({ JJ_PASSWORD_HASH: text });
    expect(config.password?.text).toBe(text);
    expect(servesWithoutToken(config)).toBe(false);
    expect(servesWithoutToken(loadServerConfig({}))).toBe(true);
    // With a password, a loopback API behind a proxy is no longer exposed.
    expect(
      loadServerConfig({
        JJ_PASSWORD_HASH: text,
        API_PUBLIC_URL: "https://jj.tail1234.ts.net",
      }).publicUrl,
    ).toBe("https://jj.tail1234.ts.net");
  });

  it("refuses a malformed JJ_PASSWORD_HASH or JJ_TRUSTED_PROXIES at boot", () => {
    expect(() => loadServerConfig({ JJ_PASSWORD_HASH: "hunter2" })).toThrow(
      ConfigError,
    );
    expect(() => loadServerConfig({ JJ_PASSWORD_HASH: "hunter2" })).toThrow(
      /^JJ_PASSWORD_HASH is not a password hash/,
    );
    expect(() => loadServerConfig({ JJ_TRUSTED_PROXIES: "my-proxy" })).toThrow(
      ConfigError,
    );
    expect(
      loadServerConfig({ JJ_TRUSTED_PROXIES: "loopback,10.0.0.0/8" })
        .trustedProxies.setting,
    ).toBe("loopback,10.0.0.0/8");
  });
});
