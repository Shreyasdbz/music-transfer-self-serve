// Theme provider: light / dark / auto (=system). Persists the preference and
// drives the [data-theme] attribute on <html> (absent for "auto" so the
// prefers-color-scheme media query in tokens.css takes over).

import { createContext, useContext, createSignal, createEffect, onCleanup, type Accessor, type JSX } from "solid-js";

export type ThemePref = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

interface ThemeCtx {
  pref: Accessor<ThemePref>;
  resolved: Accessor<ResolvedTheme>;
  setPref: (p: ThemePref) => void;
}

const Ctx = createContext<ThemeCtx>();
const STORAGE_KEY = "mtss-theme";

function readStored(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "auto" ? v : "auto";
  } catch {
    return "auto"; // locked-down WebView / disabled storage
  }
}

export function ThemeProvider(props: { children: JSX.Element }): JSX.Element {
  const [pref, setPrefSignal] = createSignal<ThemePref>(readStored());

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = createSignal(mql.matches);
  const onSystemChange = (e: MediaQueryListEvent): void => {
    setSystemDark(e.matches);
  };
  mql.addEventListener("change", onSystemChange);
  onCleanup(() => mql.removeEventListener("change", onSystemChange));

  const resolved = (): ResolvedTheme => (pref() === "auto" ? (systemDark() ? "dark" : "light") : (pref() as ResolvedTheme));

  // Reflect the preference onto <html>: explicit themes set the attribute;
  // "auto" removes it so the CSS prefers-color-scheme fallback applies.
  createEffect(() => {
    const p = pref();
    const root = document.documentElement;
    if (p === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", p);
  });

  const setPref = (p: ThemePref): void => {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* private mode — preference is session-only */
    }
    setPrefSignal(p);
  };

  return <Ctx.Provider value={{ pref, resolved, setPref }}>{props.children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used within <ThemeProvider>");
  return c;
}
