import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canReadLocationUuid,
  isWorkspaceLocationScopingEnabled,
  jwtReadAllowlist,
  legacyReadHiddenLocationIds
} from "./workspace-location-scoping.ts";

describe("workspace location scoping", () => {
  it("is currently off so every user sees every current and future subaccount", () => {
    assert.equal(isWorkspaceLocationScopingEnabled(), false);
  });

  it("ignores a stored JWT whitelist, including locations that are not in it yet", () => {
    const stored = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    assert.equal(jwtReadAllowlist(stored), null);
    assert.equal(canReadLocationUuid("brand-new-location", jwtReadAllowlist(stored)), true);
    assert.equal(canReadLocationUuid(stored[0], jwtReadAllowlist(stored)), true);
  });

  it("ignores a legacy hide list so previously hidden accounts stay readable", () => {
    const hidden = ["hidden-location"];
    assert.deepEqual(legacyReadHiddenLocationIds(hidden), []);
    assert.equal(canReadLocationUuid("hidden-location", null, hidden), true);
  });
});
