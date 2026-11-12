import { useEffect, useState } from 'react';

/**
 * Colour themes change only the brand and menu colours; every theme works in light and dark mode.
 * Both choices are saved on this device. They are applied as soon as the app loads, so nothing flashes.
 */
export const COLOR_THEMES = [
  { key: 'terracotta', label: 'Terracotta', swatch: '#c85a1e' },
  { key: 'teal', label: 'Teal', swatch: '#0f766e' },
  { key: 'indigo', label: 'Indigo', swatch: '#4f46e5' },
  { key: 'emerald', label: 'Emerald', swatch: '#047857' },
  { key: 'ocean', label: 'Ocean', swatch: '#1d4ed8' },
  { key: 'plum', label: 'Plum', swatch: '#86198f' },
] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number]['key'];

const read = (): ColorTheme => {
  const saved = localStorage.getItem('color-theme');
  return COLOR_THEMES.some((t) => t.key === saved) ? (saved as ColorTheme) : 'terracotta';
};

const apply = (theme: ColorTheme, dark: boolean) => {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', dark);
  // Keeps the phone's status bar in step with the menu colour.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--nav-from').trim() || '#15181e');
};

apply(read(), localStorage.getItem('theme') === 'dark');

export function useColorTheme() {
  const [theme, setTheme] = useState<ColorTheme>(read);
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark');
  useEffect(() => {
    localStorage.setItem('color-theme', theme);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    apply(theme, dark);
  }, [theme, dark]);
  return { theme, setTheme, dark, toggleDark: () => setDark((d) => !d) };
}

/** True when the device asks for less motion. Animations in CSS already stop; this is for motion done in code. */
export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
