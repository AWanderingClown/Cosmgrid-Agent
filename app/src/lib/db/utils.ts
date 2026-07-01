export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}
