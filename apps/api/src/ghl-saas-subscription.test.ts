import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  explainGhlSaasFetchFailure,
  isGhlForbiddenResource,
  isGhlOAuthScopeFailure,
  shouldTreatAsGhlSaasAuthFailure
} from "./ghl-saas-subscription-errors.ts";

describe("GHL SaaS error classification", () => {
  it("treats Forbidden resource 403 as an auth failure, not a generic fetch error", () => {
    assert.equal(isGhlForbiddenResource(403, "Forbidden resource"), true);
    assert.equal(shouldTreatAsGhlSaasAuthFailure(403, "Forbidden resource"), true);
    assert.equal(isGhlOAuthScopeFailure(403, "Forbidden resource"), false);
  });

  it("does not classify a successful catalog miss as a scope reconnect problem", () => {
    const explained = explainGhlSaasFetchFailure({
      ghlLocationId: "tKQSyxgMagrV5lEVSX7Q",
      lastStatus: 403,
      lastMessage: "Forbidden resource",
      sawScopeError: true,
      listCompletedWithoutMatch: true,
      oauthScopeOnFile: "saas/location.read saas/location.write"
    });
    assert.equal(explained.code, "saas_location_not_in_catalog");
    assert.match(explained.error, /tKQSyxgMagrV5lEVSX7Q/);
    assert.match(explained.error, /get-saas-subscription/);
  });

  it("explains Forbidden resource with saas/* on file without pretending the scopes are missing", () => {
    const explained = explainGhlSaasFetchFailure({
      ghlLocationId: "tKQSyxgMagrV5lEVSX7Q",
      lastStatus: 403,
      lastMessage: "Forbidden resource",
      sawScopeError: true,
      listCompletedWithoutMatch: false,
      oauthScopeOnFile: "saas/location.read locations.readonly"
    });
    assert.equal(explained.code, "ghl_scope_forbidden");
    assert.match(explained.error, /Forbidden resource/);
    assert.match(explained.error, /already lists saas\/\*/);
  });

  it("tells the operator to reconnect as Company when the JWT is Location-typed", () => {
    const explained = explainGhlSaasFetchFailure({
      ghlLocationId: "tKQSyxgMagrV5lEVSX7Q",
      lastStatus: 403,
      lastMessage: "Forbidden resource",
      sawScopeError: true,
      listCompletedWithoutMatch: false,
      oauthScopeOnFile: "saas/location.read saas/company.read",
      jwtLooksLikeLocation: true,
      jwtAuthClass: "Location"
    });
    assert.equal(explained.code, "oauth_token_is_location_typed");
    assert.match(explained.error, /Location \(subaccount\)/);
  });

  it("includes JWT authClass on a remaining Forbidden resource after a Company token was used", () => {
    const explained = explainGhlSaasFetchFailure({
      ghlLocationId: "tKQSyxgMagrV5lEVSX7Q",
      lastStatus: 403,
      lastMessage: "Forbidden resource",
      sawScopeError: true,
      listCompletedWithoutMatch: false,
      oauthScopeOnFile: "saas/company.read",
      jwtLooksLikeLocation: false,
      jwtAuthClass: "Company"
    });
    assert.equal(explained.code, "ghl_scope_forbidden");
    assert.match(explained.error, /authClass=Company/);
  });
});

