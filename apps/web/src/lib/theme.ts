import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("weave-theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("weave-theme");
      else localStorage.setItem("weave-theme", theme);
    } catch {
      /* private mode: the choice just won't persist */
    }
    window.dispatchEvent(new Event("weave-theme"));
  }, [theme]);
  return [theme, setTheme];
}

/** Is the effective theme dark right now? (Re-renders when it changes.) */
export function useIsDark(): boolean {
  const compute = () =>
    document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [dark, setDark] = useState(compute);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(compute());
    mq.addEventListener("change", on);
    window.addEventListener("weave-theme", on);
    return () => {
      mq.removeEventListener("change", on);
      window.removeEventListener("weave-theme", on);
    };
  }, []);
  return dark;
}
