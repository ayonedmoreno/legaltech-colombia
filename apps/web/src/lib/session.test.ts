import { describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "./session";

const API = "http://127.0.0.1:4000";
// Synthetic, well-formed session token: base64url alphabet (including "-" and "_") and the
// 43-character length of the API's 256-bit tokens. Never a real token.
const TOKEN = "session-token_" + "x".repeat(29);
const USER = { id: "u1", email: "ana@example.com", fullName: "Ana", role: "USER" };

describe("getCurrentUser (server-side session check)", () => {
  it("returns null without calling the API when there is no session cookie", async () => {
    const fetchImpl = vi.fn();
    expect(await getCurrentUser(undefined, API, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["a;b", "x\r\ncookie: evil=1", "tok en", "x".repeat(257)])(
    "never forwards a malformed session cookie (%#)",
    async (token) => {
      const fetchImpl = vi.fn();
      expect(await getCurrentUser(token, API, fetchImpl)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("asks the API's /me with only the session cookie, uncached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ user: USER }));

    expect(await getCurrentUser(TOKEN, API, fetchImpl)).toEqual(USER);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4000/api/auth/me");
    expect(init.headers.cookie).toBe(`__Host-session=${TOKEN}`);
    expect(init.cache).toBe("no-store");
  });

  it.each([401, 404, 500])("treats a %i answer as not authenticated", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status }));
    expect(await getCurrentUser(TOKEN, API, fetchImpl)).toBeNull();
  });

  it("treats an unreachable API as not authenticated (fail closed)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("ECONNREFUSED"));
    expect(await getCurrentUser(TOKEN, API, fetchImpl)).toBeNull();
  });
});
