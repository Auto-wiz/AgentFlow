"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { usePathname } from "next/navigation";

type Bridge = {
  topbarSlot: ReactNode | null;
  setTopbarSlot: (node: ReactNode | null) => void;
};

const AppointmentsTopbarBridgeContext = createContext<Bridge | null>(null);

export function AppointmentsTopbarBridgeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onAppointments = pathname === "/appointments" || pathname.startsWith("/appointments/");
  const [topbarSlot, setTopbarSlotState] = useState<ReactNode | null>(null);

  const setTopbarSlot = useCallback((node: ReactNode | null) => {
    setTopbarSlotState(node);
  }, []);

  useEffect(() => {
    if (!onAppointments) {
      setTopbarSlotState(null);
    }
  }, [onAppointments]);

  const value = useMemo(() => ({ topbarSlot, setTopbarSlot }), [setTopbarSlot, topbarSlot]);

  return (
    <AppointmentsTopbarBridgeContext.Provider value={value}>{children}</AppointmentsTopbarBridgeContext.Provider>
  );
}

export function AppointmentsTopbarOutlet() {
  const ctx = useContext(AppointmentsTopbarBridgeContext);
  return ctx?.topbarSlot ?? null;
}

export function useAppointmentsTopbarSlot() {
  const ctx = useContext(AppointmentsTopbarBridgeContext);
  if (!ctx) {
    throw new Error("useAppointmentsTopbarSlot must run inside AppointmentsTopbarBridgeProvider");
  }
  return ctx.setTopbarSlot;
}
