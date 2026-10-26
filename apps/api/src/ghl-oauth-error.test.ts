import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitizeGhlOAuthError } from "./ghl-oauth-error.ts";

describe("sanitizeGhlOAuthError", () => {
  it("keeps HighLevel error codes and drops long secrets", () => {
    const message = sanitizeGhlOAuthError(401, {
      error: "invalid_grant",
      error_description: "refresh rejected bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    });
    assert.match(message, /refresh rejected bearer \[redacted\]/);
    assert.equal(message.includes("eyJ"), false);
  });

  it("reads the first string in a message array", () => {
    assert.equal(sanitizeGhlOAuthError(400, { message: ["Location is not installed"] }), "Location is not installed");
  });

  it("falls back to the HTTP status", () => {
    assert.equal(sanitizeGhlOAuthError(401, {}), "http_401");
  });
});
