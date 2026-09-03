import { describe, expect, it } from "vitest";
import { readServerError } from "./serverError";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readServerError", () => {
  // The regression this whole file exists for: a render-route 503 carries the
  // application-level cause and repair, and Studio used to show only the status.
  it("prefers the server's cause and remediation over the status code", async () => {
    const res = jsonResponse(
      {
        error: "Bundled media tools unavailable",
        hint: "Reinstall MpVFX to restore its bundled media tools.",
      },
      503,
    );

    await expect(readServerError(res)).resolves.toBe(
      "Bundled media tools unavailable. Reinstall MpVFX to restore its bundled media tools.",
    );
  });

  it("uses the cause alone when the server sends no hint", async () => {
    const res = jsonResponse({ error: "Bundled media tools unavailable" }, 503);

    await expect(readServerError(res)).resolves.toBe("Bundled media tools unavailable");
  });

  it("falls back to the status code when the body is not JSON", async () => {
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });

    await expect(readServerError(res)).resolves.toBe(
      "Server error (502). Check the terminal for details.",
    );
  });

  it("falls back to the status code when the JSON carries no error string", async () => {
    const res = jsonResponse({ hint: "Reinstall MpVFX." }, 500);

    await expect(readServerError(res)).resolves.toBe(
      "Server error (500). Check the terminal for details.",
    );
  });

  it("ignores a non-string error rather than rendering it as an object", async () => {
    const res = jsonResponse({ error: { code: 17 } }, 500);

    await expect(readServerError(res)).resolves.toBe(
      "Server error (500). Check the terminal for details.",
    );
  });
});
