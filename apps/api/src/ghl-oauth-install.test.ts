import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE,
  GHL_MARKETPLACE_APP_VERSION_ID,
  applyGhlMarketplaceUserType,
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

  it("forces user_type=Company even when the Marketplace URL omitted it or asked for Location", () => {
    const missing = new URL("https://marketplace.gohighlevel.com/v2/oauth/chooselocation");
    applyGhlMarketplaceUserType(missing, undefined);
    assert.equal(missing.searchParams.get("user_type"), "Company");

    const location = new URL(
      "https://marketplace.gohighlevel.com/v2/oauth/chooselocation?user_type=Location"
    );
    applyGhlMarketplaceUserType(location, "Company");
    assert.equal(location.searchParams.get("user_type"), "Company");
  });

  it("pins Company OAuth and charging=true in wrangler vars so deploys recreate them", () => {
    const wranglerPath = fileURLToPath(new URL("../wrangler.toml", import.meta.url));
    const wrangler = readFileSync(wranglerPath, "utf8");
    assert.match(wrangler, /GHL_OAUTH_USER_TYPE\s*=\s*"Company"/);
    assert.match(wrangler, /CLIENT_CHARGES_CHARGING_ENABLED\s*=\s*"true"/);
    assert.match(wrangler, /user_type=Company/);
  });
});
