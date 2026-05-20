"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const storageKey = "agentflow-theme";

function getPreferredTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }
  const storedTheme = window.localStorage.getItem(storageKey);
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }
  return "dark";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(storageKey, theme);
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initialTheme = getPreferredTheme();
    setTheme(initialTheme);
    applyTheme(initialTheme);
    setMounted(true);
  }, []);

  function toggleTheme() {
    const nextTheme: Theme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    applyTheme(nextTheme);
  }

  return (
    <button
      aria-label={mounted ? (theme === "light" ? "Switch to dark mode" : "Switch to light mode") : "Toggle theme"}
      className={`button secondary theme-toggle-icon ${compact ? "theme-toggle-compact" : ""}`}
      onClick={toggleTheme}
      title={mounted ? (theme === "light" ? "Dark mode" : "Light mode") : "Theme"}
      type="button"
    >
      {mounted ? (theme === "light" ? "☾" : "☀") : "◐"}
    </button>
  );
}
