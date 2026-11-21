// Adjust tab Undo (lib/filters/history.ts): every params change is one step back, per slide.
import { eq, ok, test } from "./harness";
import { useStore } from "../src/lib/store";
import { DEFAULT_FILTERS } from "../src/lib/types";
import { undoAdjustment } from "../src/lib/filters/history";

const params = () => useStore.getState().filters.params;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("adjust undo: Normalise, then a slider, step back one at a time to the start", async () => {
  useStore.setState((s) => ({ slide: { ...s.slide, path: "/tmp/undo-a.svs" } }));
  useStore.getState().setFilters({ params: { ...DEFAULT_FILTERS } });
  await wait(700);
  const start = params();
  useStore.getState().setFilterParams({ normalize: true });
  await wait(700);
  for (const g of [1.1, 1.2, 1.3]) useStore.getState().setFilterParams({ gamma: g }); // one drag = one step
  eq(params().gamma, 1.3, "dragged");
  ok(undoAdjustment(), "undo the drag");
  eq([params().gamma, params().normalize], [start.gamma, true], "drag undone in one step, still normalised");
  ok(undoAdjustment(), "undo normalise");
  eq(params().normalize, false, "normalise undone");
  ok(!undoAdjustment() || JSON.stringify(params()) === JSON.stringify(DEFAULT_FILTERS), "back at the start");
});

test("adjust undo: opening another slide starts a fresh history", () => {
  useStore.getState().setFilterParams({ invert: true });
  useStore.setState((s) => ({ slide: { ...s.slide, path: "/tmp/undo-b.svs" } }));
  ok(!undoAdjustment(), "nothing to undo on the new slide");
});
