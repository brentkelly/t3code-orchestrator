/**
 * T3o: a short, stable key for a queued task's setting value, folded into the
 * derived settings-sync commandIds (issue #120).
 *
 * Those ids are `${message.commandId}:${setting}`, and an edited queued task
 * keeps its commandId. The server dedups by commandId, so a retry after the
 * user changed the model selection reused the id of the earlier sync: it used
 * to be swallowed as a replay, and is now refused as a commandId conflict.
 * Keying the id on the value makes a changed setting a new command while an
 * unchanged retry keeps its id and still replays idempotently.
 */

/** JSON with object keys sorted and `undefined` members dropped, recursively. */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
};

/** FNV-1a (32-bit) of the value's canonical JSON, as 8 hex digits. */
export function settingValueKey(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
