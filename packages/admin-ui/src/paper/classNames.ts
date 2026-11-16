export function join(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}
