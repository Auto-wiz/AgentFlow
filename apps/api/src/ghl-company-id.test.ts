import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPlaceholderGhlCompanyId,
  pickFirstUsableGhlCompanyId,
  usableGhlCompanyId
} from "./ghl-company-id.ts";
import { ghlJwtScopeIncludesSaas } from "./ghl-access-token-claims.ts";

function unsignedJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("GHL company id placeholders", () => {
  it("rejects default/demo/test agency ids that are not HighLevel company ids", () => {
    assert.equal(isPlaceholderGhlCompanyId("default"), true);
    assert.equal(isPlaceholderGhlCompanyId("agency_demo_001"), true);
    assert.equal(isPlaceholderGhlCompanyId("test-company-1778616985720"), true);
    assert.equal(usableGhlCompanyId("default"), null);
    assert.equal(usableGhlCompanyId("e0Z1AzINaqYtX9mJe2m8"), "e0Z1AzINaqYtX9mJe2m8");
    assert.equal(
      pickFirstUsableGhlCompanyId(["default", "agency_demo_001", "e0Z1AzINaqYtX9mJe2m8"]),
      "e0Z1AzINaqYtX9mJe2m8"
    );
  });

  it("reads saas scopes from GHL JWT oauthMeta.scopes arrays", () => {
    const token = unsignedJwt({
      authClass: "Company",
      oauthMeta: { scopes: ["locations.readonly", "saas/company.read", "saas/location.read"] }
    });
    assert.equal(ghlJwtScopeIncludesSaas(token), true);
  });
});
