import { input, password, select, confirm } from '@inquirer/prompts';

export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 2) { super(message); }
}
export function interactive(disabled = false): boolean { return !disabled && !!process.stdin.isTTY && !!process.stderr.isTTY; }
export async function text(label: string, allowed = interactive(), defaultValue?: string): Promise<string> {
  if (!allowed) throw new CliError('INPUT_REQUIRED', `${label} is required; supply its flag in scripts`);
  return input({ message: label, default: defaultValue }, { output: process.stderr });
}
export async function hidden(label: string, allowed = interactive()): Promise<string> {
  if (!allowed) throw new CliError('INPUT_REQUIRED', `${label} is required; use its environment variable or protected file`);
  return password({ message: label, mask: '*' }, { output: process.stderr });
}
export async function choose(label: string, choices: { name: string; value: string }[], allowed: boolean): Promise<string> {
  if (!allowed) throw new CliError('INPUT_REQUIRED', `${label} is required; supply its flag in scripts`);
  if (!choices.length) throw new CliError('NOT_FOUND', `No choices available: ${label}`);
  return select({ message: label, choices }, { output: process.stderr });
}
export async function acknowledge(label: string, allowed: boolean): Promise<boolean> {
  if (!allowed) throw new CliError('INPUT_REQUIRED', `${label}; explicit confirmation flag required`);
  return confirm({ message: label, default: false }, { output: process.stderr });
}
