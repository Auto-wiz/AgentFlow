import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPortfolioDashboardEnabled,
  isPortfolioDashboardExclusionsEnabled
} from "../../../packages/shared/src/portfolio-dashboard.ts";

describe("portfolio dashboard pause", () => {
  it("keeps the Overview KPIs on so appointment counts stay visible", () => {
    assert.equal(isPortfolioDashboardEnabled(), true);
  });

  it("keeps the exclusion picker off so nobody can hide subaccounts", () => {
    assert.equal(isPortfolioDashboardExclusionsEnabled(), false);
  });
});
