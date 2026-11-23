import { Doc, type Op } from "../src/index.js";

/** Small deterministic PRNG (mulberry32) so failing seeds can be replayed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

export type Rng = ReturnType<typeof rng>;

/** Shuffle in place (Fisher–Yates) with the given PRNG. */
export function shuffle<T>(xs: T[], r: Rng): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

/** Make a random local edit: mostly typing (runs), sometimes deletions. */
export function randomEdit(doc: Doc, r: Rng): Op | null {
  const len = doc.length;
  if (len > 0 && r.next() < 0.3) {
    const pos = r.int(len);
    const n = 1 + r.int(Math.min(5, len - pos));
    return doc.delete(pos, n);
  }
  const pos = r.int(len + 1);
  const words = ["a", "bc", "def", "XY", " ", "q", "\n", "héllo", "😀"];
  return doc.insert(pos, r.pick(words));
}

/** Fully sync every doc with every other (delivering ops in a random order, with duplicates). */
export function syncAll(docs: Doc[], r: Rng): void {
  const all: Op[] = [];
  for (const d of docs) all.push(...d.opsSince({}));
  for (const d of docs) {
    const delivery = shuffle([...all, ...all.slice(0, r.int(all.length + 1))], r);
    d.apply(delivery);
  }
}
