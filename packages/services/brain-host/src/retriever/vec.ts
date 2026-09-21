/**
 * Tiny dense-vector helpers. Vectors are L2-normalized Float32Arrays so
 * cosine similarity is a plain dot product, and they round-trip to SQLite
 * BLOBs as raw little-endian float32 bytes.
 */

export function normalize(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

export function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy into an aligned buffer: SQLite blobs are not guaranteed 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Top-k indices by descending score; ties keep insertion order. */
export function topK(scores: ArrayLike<number>, k: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < scores.length; i++) idx.push(i);
  idx.sort((a, b) => scores[b]! - scores[a]! || a - b);
  return idx.slice(0, Math.max(0, k));
}
