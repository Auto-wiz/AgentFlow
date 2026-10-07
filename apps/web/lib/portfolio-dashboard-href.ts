import { canAccessClientCharges, isPortfolioDashboardEnabled } from "@agentflow/shared";

export function pausedPortfolioFallbackHref(
  email: string | null | undefined,
  role?: string | null
): string {
  return canAccessClientCharges(email, role) ? "/dashboard/client-charges" : "/appointments";
}

export function dashboardNavHref(email: string | null | undefined, role?: string | null): string {
  if (!isPortfolioDashboardEnabled()) {
    return pausedPortfolioFallbackHref(email, role);
  }
  return "/dashboard";
}

export function shouldShowDashboardNav(email: string | null | undefined, role?: string | null): boolean {
  if (isPortfolioDashboardEnabled()) return true;
  return canAccessClientCharges(email, role);
}
