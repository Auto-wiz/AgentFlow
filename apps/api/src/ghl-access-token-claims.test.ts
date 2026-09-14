import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeGhlAccessTokenClaims,
  ghlTokenLooksLikeLocation,
  pickCompanyTypedAccessTokens
} from "./ghl-access-token-claims.ts";

function unsignedJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("GHL access token claims", () => {
  it("decodes authClass from a GHL-shaped JWT", () => {
    const token = unsignedJwt({
      authClass: "Company",
      companyId: "agency_1",
      scope: "saas/company.read locations.readonly"
    });
    const claims = decodeGhlAccessTokenClaims(token);
    assert.equal(claims?.authClass, "Company");
    assert.equal(ghlTokenLooksLikeLocation(token), false);
  });

  it("treats Location authClass JWTs as unusable for agency SaaS", () => {
    const location = unsignedJwt({ authClass: "Location", locationId: "loc_1" });
    const company = unsignedJwt({ authClass: "Company", companyId: "agency_1" });
    assert.equal(ghlTokenLooksLikeLocation(location), true);
    const picked = pickCompanyTypedAccessTokens([location, company]);
    assert.deepEqual(picked.tokens, [company]);
    assert.equal(picked.rejectedLocationTypedJwt, false);
  });

  it("rejects a Company DB row whose JWT is actually Location-typed", () => {
    const location = unsignedJwt({ authClass: "Location", userType: "Location" });
    const picked = pickCompanyTypedAccessTokens([location]);
    assert.deepEqual(picked.tokens, []);
    assert.equal(picked.rejectedLocationTypedJwt, true);
  });

  it("keeps opaque non-JWT tokens", () => {
    const pit = "pit-not-a-jwt";
    const picked = pickCompanyTypedAccessTokens([pit]);
    assert.deepEqual(picked.tokens, [pit]);
    assert.equal(picked.rejectedLocationTypedJwt, false);
  });
});
