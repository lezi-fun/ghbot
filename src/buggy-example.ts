export function explodeOnUndefined(input?: string): string {
  return input!.trim().toUpperCase();
}

export function parseCount(value: string): number {
  return JSON.parse(value).count;
}
