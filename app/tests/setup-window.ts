// Imported first by logic.test.ts: src/lib/backend.ts reads `window` when it loads (and the store imports it).
import { JSDOM } from "jsdom";

const g = globalThis as { window?: unknown };
g.window ??= new JSDOM().window;
