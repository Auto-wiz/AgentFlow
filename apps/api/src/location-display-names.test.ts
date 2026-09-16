import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  catalogNamePreservingStored,
  locationNameNeedsGhlRefresh,
  overlayLocationDisplayName
} from "./location-display-name-policy.ts";

describe("client charges location display names", () => {
  it("replaces a stale stored subaccount name with the live GHL name", () => {
    assert.equal(
      overlayLocationDisplayName("Lacy Messinger's Account", "Lacy from Black Label Society Salon & Spa"),
      "Lacy from Black Label Society Salon & Spa"
    );
    assert.equal(
      overlayLocationDisplayName("(PAUSED)Tanisha from Beauty Elevation", "Tanisha from Beauty Elevation"),
      "Tanisha from Beauty Elevation"
    );
    assert.equal(overlayLocationDisplayName(null, "Hitesh from OYESPA LLC"), "Hitesh from OYESPA LLC");
  });

  it("keeps the stored name when GHL does not return one", () => {
    assert.equal(overlayLocationDisplayName("Hannah from EZ Messenger", null), "Hannah from EZ Messenger");
    assert.equal(overlayLocationDisplayName(null, "  "), null);
  });

  it("does not let a SaaS catalog name overwrite a stored location name", () => {
    assert.equal(
      catalogNamePreservingStored("Lacy from Black Label Society Salon & Spa", "Lacy Messinger's Account"),
      "Lacy from Black Label Society Salon & Spa"
    );
    assert.equal(catalogNamePreservingStored(null, "Hitesh from OYESPA LLC"), "Hitesh from OYESPA LLC");
  });

  it("refreshes existing names on Client Charges, not only blanks", () => {
    assert.equal(locationNameNeedsGhlRefresh("Lacy Messinger's Account", true), true);
    assert.equal(locationNameNeedsGhlRefresh("Lacy Messinger's Account", false), false);
    assert.equal(locationNameNeedsGhlRefresh(null, false), true);
  });
});
