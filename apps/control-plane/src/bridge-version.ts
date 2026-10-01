/** Order two Bridge semantic versions; an unparsable version sorts first. */
export function compareBridgeVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number, string] => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) return [-1, -1, -1, value];
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] as number) < (b[index] as number) ? -1 : 1;
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3], undefined, { numeric: true });
}
