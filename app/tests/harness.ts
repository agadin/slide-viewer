/**
 * Tiny test runner in Micro Speed Grader's style: PASS/FAIL lines, exit code 1 on any failure.
 *   test("name", () => { ok(cond, "what should hold"); });   // async functions are fine too
 * Each feature has its own tests/<feature>.test.ts (owned by that builder) imported by logic.test.ts.
 */
import path from "node:path";

let fails = 0;
let passes = 0;
export const ok = (c: unknown, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (c) passes++;
  else fails++;
};
export const eq = (a: unknown, b: unknown, m: string) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, sa === sb ? m : `${m} (got ${sa}, want ${sb})`);
};
export const near = (a: number, b: number, eps: number, m: string) => ok(Math.abs(a - b) <= eps, `${m} (${a} ≈ ${b})`);

/** the test-data folder (npm run test:logic passes ../test-data); may not exist on CI */
export const dataDir = path.resolve(process.argv[2] ?? "../test-data");

const tests: { name: string; fn: () => unknown }[] = [];
export const test = (name: string, fn: () => unknown) => void tests.push({ name, fn });

export async function run() {
  for (const t of tests) {
    console.log(`# ${t.name}`);
    try {
      await t.fn();
    } catch (e) {
      ok(false, `${t.name} threw: ${e instanceof Error ? e.stack : e}`);
    }
  }
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
