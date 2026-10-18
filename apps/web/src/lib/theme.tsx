import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "theme";
const PALETTE_KEY = "palette";

/** The default is pink. A palette recolours the sidebar, buttons and highlights. Keep the names in sync with src/index.css. */
export const PALETTES = [
  { id: "pink", label: "Pink", swatch: "oklch(0.62 0.22 352)" },
  { id: "ocean", label: "Ocean", swatch: "oklch(0.58 0.2 240)" },
  { id: "forest", label: "Forest", swatch: "oklch(0.55 0.15 155)" },
  { id: "sunset", label: "Sunset", swatch: "oklch(0.64 0.2 48)" },
  { id: "grape", label: "Grape", swatch: "oklch(0.55 0.22 305)" },
  { id: "graphite", label: "Graphite", swatch: "oklch(0.45 0.03 255)" },
] as const;
export type Palette = (typeof PALETTES)[number]["id"];

const readPalette = (): Palette => {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    return PALETTES.some((p) => p.id === v) ? (v as Palette) : "pink";
  } catch {
    return "pink";
  }
};

const readStored = (): Theme => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void; palette: Palette; setPalette: (p: Palette) => void } | null>(null);

/** The first paint is themed by the inline script in index.html. This keeps it in sync afterwards. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [palette, setPaletteState] = useState<Palette>(readPalette);

  useEffect(() => {
    if (palette === "pink") document.documentElement.removeAttribute("data-palette");
    else document.documentElement.setAttribute("data-palette", palette);
  }, [palette]);

  const setPalette = useCallback((p: Palette) => {
    setPaletteState(p);
    try {
      localStorage.setItem(PALETTE_KEY, p);
    } catch {
      /* private mode: the choice just won't persist */
    }
  }, []);

  useEffect(() => {
    apply(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode: the choice just won't persist */
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme, palette, setPalette }), [theme, setTheme, palette, setPalette]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme needs a ThemeProvider");
  return ctx;
}
