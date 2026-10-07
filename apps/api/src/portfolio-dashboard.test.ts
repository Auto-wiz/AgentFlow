import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPortfolioDashboardEnabled } from "../../../packages/shared/src/portfolio-dashboard.ts";

describe("portfolio dashboard pause", () => {
  it("is currently off so overview and exclusions do not run", () => {
    assert.equal(isPortfolioDashboardEnabled(), false);
  });
});
