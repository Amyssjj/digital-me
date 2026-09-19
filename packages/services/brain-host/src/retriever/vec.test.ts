import { describe, expect, it } from "vitest";
import { dot, fromBlob, normalize, toBlob, topK } from "./vec.js";

describe("vec", () => {
  it("normalizes to unit length and leaves the zero vector alone", () => {
    const v = normalize([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect(Array.from(normalize([0, 0]))).toEqual([0, 0]);
  });

  it("dot product uses the shorter length", () => {
    expect(dot(new Float32Array([1, 2, 3]), new Float32Array([1, 1]))).toBe(3);
  });

  it("round-trips through blobs even when the blob is unaligned", () => {
    const v = normalize([1, 2, 3, 4]);
    const blob = toBlob(v);
    const padded = new Uint8Array(blob.length + 1);
    padded.set(blob, 1);
    const back = fromBlob(padded.subarray(1));
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  it("topK orders by score descending with stable ties and clamps k", () => {
    expect(topK([0.1, 0.9, 0.5, 0.9], 3)).toEqual([1, 3, 2]);
    expect(topK([1, 2], -1)).toEqual([]);
  });
});
