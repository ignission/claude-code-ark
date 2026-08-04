import { describe, expect, it } from "vitest";
import { rememberFifoEntry } from "./bounded-fifo-map.js";

describe("rememberFifoEntry", () => {
  it("257件目で最古の要素を削除し、256件以内に保つ", () => {
    const entries = new Map<string, number>();

    for (let index = 0; index < 257; index += 1) {
      rememberFifoEntry(entries, `model-${index}`, index, 256);
    }

    expect(entries).toHaveLength(256);
    expect(entries.has("model-0")).toBe(false);
    expect(entries.get("model-1")).toBe(1);
    expect(entries.get("model-256")).toBe(256);
  });
});
