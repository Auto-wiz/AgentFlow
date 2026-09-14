import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE,
  GHL_MARKETPLACE_APP_VERSION_ID,
  applyGhlMarketplaceVersionId
} from "../../../packages/shared/src/ghl-marketplace-oauth.ts";

describe("GHL Marketplace install version", () => {
  it("overwrites a stale version_id from a previous Marketplace app version", () => {
    const url = new URL(
      "https://marketplace.gohighlevel.com/v2/oauth/chooselocation?version_id=6a6a3c701a53bd484390b873"
    );
    applyGhlMarketplaceVersionId(url, GHL_MARKETPLACE_APP_VERSION_ID);
    assert.equal(url.searchParams.get("version_id"), "6a6b5864ba65c71d784c0347");
    assert.equal(url.searchParams.get("versionId"), null);
  });

  it("includes charges and saas/company.read from the published install URL", () => {
    assert.match(DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE, /charges\.readonly/);
    assert.match(DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE, /charges\.write/);
    assert.match(DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE, /saas\/location\.read/);
    assert.match(DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE, /saas\/company\.read/);
  });
});
