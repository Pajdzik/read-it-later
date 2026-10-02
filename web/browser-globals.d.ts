import type Defuddle from "defuddle/full";

declare global {
  interface Window {
    PotemDefuddle?: typeof Defuddle;
  }

  var PotemDefuddle: typeof Defuddle;
}

export {};
