export const APPEARANCE_THEMES = ["light", "dark", "rainbow"] as const;

export type AppearanceTheme = typeof APPEARANCE_THEMES[number];
export type NativeAppearanceTheme = "light" | "dark";

export function nativeAppearanceFor(theme: AppearanceTheme): NativeAppearanceTheme {
  return theme === "dark" ? "dark" : "light";
}

export function windowBackgroundFor(theme: AppearanceTheme): string {
  return theme === "dark" ? "#08111f" : "#ffffff";
}
