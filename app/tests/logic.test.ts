// Headless logic tests. Run: npm run test:logic  (bundled with rolldown, run with node + jsdom)
// Each feature's tests live in its own file (owned by that builder); add new files to the list below.
import "./setup-window";
import "./xml-parser";
import { run } from "./harness";
import "./foundation.test";
import "./annotations.test";
import "./filters.test";
import "./browser.test";
import "./viewer.test";
import "./formats.test";

await run();
