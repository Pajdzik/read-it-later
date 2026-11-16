import type Defuddle from "defuddle/full";

declare global {
  interface Window {
    PotemDefuddle?: typeof Defuddle;
    potemTheme?: {
      get(): { palette: "green" | "brown"; appearance: "system" | "light" | "dark" };
      set(preferences: { palette?: string; appearance?: string }): void;
      subscribe(listener: () => void): () => void;
    };
  }

  var PotemDefuddle: typeof Defuddle;
}

export {};
