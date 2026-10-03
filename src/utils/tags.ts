// Host tags. Free-form labels for filtering, plus one reserved tag: `lab` marks a lab device, the
// only kind GreenCLI offers to Casper for lab checks. It is always spelled `lab` and listed first.

export const LAB_TAG = 'lab';

/** Trimmed, no empties, no repeats; any spelling of the lab tag becomes `lab`, listed first. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase() === LAB_TAG ? LAB_TAG : raw.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.includes(LAB_TAG) ? [LAB_TAG, ...out.filter((t) => t !== LAB_TAG)] : out;
}

/** True for the reserved lab tag, in any spelling (tags saved before it was reserved may be `Lab`). */
export function isLabTag(tag: string): boolean {
  return tag.trim().toLowerCase() === LAB_TAG;
}

/** True when a host carries the reserved lab tag (any spelling). */
export function isLabHost(host: { tags?: readonly string[] }): boolean {
  return (host.tags ?? []).some(isLabTag);
}
