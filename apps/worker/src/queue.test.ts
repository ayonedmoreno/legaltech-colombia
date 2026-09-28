import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPeriodicSweep, type SweepResult } from "./queue.js";

const NOTHING: SweepResult = { requeued: [], failed: [] };

describe("startPeriodicSweep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sweeps every interval until stopped", async () => {
    const sweep = vi.fn(async () => NOTHING);
    const stop = startPeriodicSweep(sweep, 60_000, () => {});

    await vi.advanceTimersByTimeAsync(59_999);
    expect(sweep).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it("never runs two sweeps at once: a slow sweep skips the next ticks", async () => {
    let finish: (result: SweepResult) => void = () => {};
    const sweep = vi.fn(() => new Promise<SweepResult>((resolve) => (finish = resolve)));
    const stop = startPeriodicSweep(sweep, 1_000, () => {});

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish(NOTHING);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
  });

  it("logs a failed sweep and tries again on the next tick", async () => {
    const log = vi.fn();
    const sweep = vi
      .fn<() => Promise<SweepResult>>()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue({ requeued: ["a"], failed: ["b", "c"] });
    const stop = startPeriodicSweep(sweep, 1_000, log);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toHaveBeenLastCalledWith({
      level: "error",
      message: "sweep failed",
      error: "connection lost",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    // Counts only: no document ids in the log line.
    expect(log).toHaveBeenLastCalledWith({
      level: "info",
      message: "sweep",
      requeued: 1,
      failed: 2,
    });
    stop();
  });

  it("logs nothing when a sweep found nothing to do", async () => {
    const log = vi.fn();
    const stop = startPeriodicSweep(async () => NOTHING, 1_000, log);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(log).not.toHaveBeenCalled();
    stop();
  });
});
