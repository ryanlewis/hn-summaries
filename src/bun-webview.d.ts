// Minimal ambient types for the slice of Bun.WebView this project uses.
// We deliberately avoid depending on the full @types/bun, whose fetch/Response/DOM
// typings collide with the Node globals this codebase relies on (see the header of
// extract.ts on why the "DOM" lib is kept out). Bun.WebView arrived in Bun 1.3.12.
export {};

declare global {
  class BunWebView {
    constructor(options?: {
      backend?: "webkit" | "chrome";
      url?: string;
      width?: number;
      height?: number;
      dataStore?: "ephemeral" | { directory: string };
      console?: (...args: unknown[]) => void;
    });
    navigate(url: string): Promise<void>;
    /** Runs an expression in the page; returns its JSON-serialized result. */
    evaluate(script: string): Promise<unknown>;
    /** Synchronous, idempotent. */
    close(): void;
  }

  const Bun: {
    WebView: typeof BunWebView & {
      /** Force-kills all spawned browser subprocesses. */
      closeAll(): void;
    };
  };
}
