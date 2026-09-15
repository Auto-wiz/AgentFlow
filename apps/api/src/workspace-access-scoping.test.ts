import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isWorkspaceLocationScopingEnabled } from "./workspace-location-scoping.ts";

describe("workspace location scoping", () => {
  it("is currently off so every user sees every current and future subaccount", () => {
    assert.equal(isWorkspaceLocationScopingEnabled(), false);
  });
});
