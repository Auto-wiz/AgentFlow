/**
 * Overview KPIs: booked appointments vs collected payments per subaccount.
 * Flip to false only if the whole dashboard table should go away again.
 */
export function isPortfolioDashboardEnabled(): boolean {
  return true;
}

/**
 * Portfolio admin picker: hide/show individual subaccounts on the dashboard.
 * Off so nobody can choose a subset; stored exclude_from_dashboard rows are ignored.
 * Flip to true to restore the Portfolio admin tab and exclusion filtering.
 */
export function isPortfolioDashboardExclusionsEnabled(): boolean {
  return false;
}
