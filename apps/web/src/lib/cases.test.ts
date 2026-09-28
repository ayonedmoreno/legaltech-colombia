import { describe, expect, it, vi } from "vitest";
import { getOwnCase, getOwnCases } from "./cases";

const API = "http://127.0.0.1:4000";
// Synthetic, well-formed session token (base64url, 43 characters). Never a real token.
const TOKEN = "session-token_" + "x".repeat(29);
const CASE_ID = "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11";
const AT = "2026-09-27T12:00:00.000Z";
const CASE = { id: CASE_ID, type: "OTHER", status: "DRAFT", createdAt: AT, updatedAt: AT };

describe("server-side reads of the user's own cases", () => {
  it("asks the API's /api/cases with only the session cookie, uncached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ cases: [CASE] }));

    expect(await getOwnCases(TOKEN, API, fetchImpl)).toEqual({ kind: "ok", data: [CASE] });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4000/api/cases");
    expect(init.headers.cookie).toBe(`__Host-session=${TOKEN}`);
    expect(init.cache).toBe("no-store");
  });

  it.each([
    [401, "unauthenticated"],
    [404, "not_found"],
    [500, "error"],
  ])("maps a %i answer to %s", async (status, kind) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status }));
    expect(await getOwnCases(TOKEN, API, fetchImpl)).toEqual({ kind });
  });

  it("never calls the API without a well-formed session cookie", async () => {
    const fetchImpl = vi.fn();
    expect(await getOwnCases(undefined, API, fetchImpl)).toEqual({ kind: "unauthenticated" });
    expect(await getOwnCases("a;b", API, fetchImpl)).toEqual({ kind: "unauthenticated" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads one case by its id", async () => {
    const detail = {
      case: CASE,
      statusHistory: [{ fromStatus: null, toStatus: "DRAFT", changedAt: AT }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(detail));

    expect(await getOwnCase(CASE_ID, TOKEN, API, fetchImpl)).toEqual({ kind: "ok", data: detail });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`http://127.0.0.1:4000/api/cases/${CASE_ID}`);
  });

  it.each(["not-a-uuid", "../auth/me", `${CASE_ID}?x=1`])(
    "never sends a malformed case id (%s) to the API: not found",
    async (id) => {
      const fetchImpl = vi.fn();
      expect(await getOwnCase(id, TOKEN, API, fetchImpl)).toEqual({ kind: "not_found" });
      expect(await getOwnCase(id, undefined, API, fetchImpl)).toEqual({
        kind: "unauthenticated",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
