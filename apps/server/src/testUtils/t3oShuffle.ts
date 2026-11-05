/**
 * T3o (T3O-45): `T3O_SHUFFLE_SEED=<n>` shuffles test files within each project,
 * to prove the non-isolated board project does not depend on file order.
 */
// mulberry32, so a failing order replays from its seed.
const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffleWithinProjects = <T extends { readonly project: { readonly name: string } }>(
  files: ReadonlyArray<T>,
  seed: string | undefined,
): Array<T> => {
  if (!seed) return [...files];
  const random = seededRandom(Number(seed));
  const out = [...files];
  let start = 0;
  while (start < out.length) {
    let end = start + 1;
    while (end < out.length && out[end]!.project.name === out[start]!.project.name) end += 1;
    for (let index = end - 1; index > start; index -= 1) {
      const pick = start + Math.floor(random() * (index - start + 1));
      [out[index], out[pick]] = [out[pick]!, out[index]!];
    }
    start = end;
  }
  return out;
};
