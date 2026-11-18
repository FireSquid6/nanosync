import { input, password, select, confirm } from '@inquirer/prompts';
import { output, readable } from './output.ts';

export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 2) { super(message); }
}
export function interactive(disabled = false): boolean {
  return !disabled && process.env.TERM !== 'dumb'
    && !!process.stdin.isTTY && !!output().promptStream.isTTY;
}
export async function text(label: string, allowed = interactive(), defaultValue?: string): Promise<string> {
  if (!allowed) throw new CliError('INPUT_REQUIRED', `${label} is required; supply its flag in scripts`);
  return output().prompt(() => input(
    { message: readable(label), default: defaultValue }, { output: output().promptStream },
  ));
}
export async function hidden(label: string, allowed = interactive()): Promise<string> {
  if (!allowed) {
    throw new CliError(
      'INPUT_REQUIRED', `${label} is required; use its environment variable or protected file`,
    );
  }
  return output().prompt(() => password(
    { message: readable(label), mask: '*' }, { output: output().promptStream },
  ));
}
export async function choose(label: string, choices: { name: string; value: string }[], allowed: boolean,
  emptyMessage = `No choices available: ${label}`): Promise<string> {
  if (!allowed) throw new CliError('INPUT_REQUIRED', `${label} is required; supply its flag in scripts`);
  if (!choices.length) throw new CliError('NOT_FOUND', emptyMessage);
  const safeChoices = choices.map(choice => ({
    ...choice, name: readable(choice.name).replace(/[\r\n\t]/gu, ' '),
  }));
  return output().prompt(() => select(
    { message: readable(label), choices: safeChoices }, { output: output().promptStream },
  ));
}
export async function acknowledge(label: string, allowed: boolean): Promise<boolean> {
  if (!allowed) throw new CliError('INPUT_REQUIRED', `${label}; explicit confirmation flag required`);
  return output().prompt(() => confirm(
    { message: readable(label), default: false }, { output: output().promptStream },
  ));
}
