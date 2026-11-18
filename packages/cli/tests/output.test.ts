import { expect, spyOn, test } from 'bun:test';
import * as oraModule from 'ora';
import type { Ora } from 'ora';
import { CliOutput, output, readable, terminalStyle, withOutput } from '../src/output.ts';
import { main } from '../src/main.ts';

function capture() {
  const stdout = spyOn(console, 'log').mockImplementation(() => {});
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  const help = spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { stdout, stderr, help, restore() { stdout.mockRestore(); stderr.mockRestore(); help.mockRestore(); } };
}

test('all command groups print their own help successfully in either mode', async () => {
  const captured = capture();
  try {
    const groups = [[], ['server'], ['server', 'devices'], ['server', 'vaults'], ['server', 'admin'],
      ['client'], ['client', 'connections'], ['client', 'vaults']];
    for (const group of groups) {
      for (const flags of [[], ['--json']]) {
        captured.help.mockClear();
        expect(await main([...group, ...flags])).toBe(0);
        const help = captured.help.mock.calls.flat().join('');
        expect(help).toContain(`Usage: nanosync${group.length ? ' ' + group.join(' ') : ''} `);
        expect(help).toContain('Commands:');
      }
    }
    expect(captured.stderr).not.toHaveBeenCalled();
    expect(captured.stdout).not.toHaveBeenCalled();
  } finally { captured.restore(); }
});

test('human errors use stdout, JSON errors retain their contract, and mode does not leak', async () => {
  const captured = capture();
  try {
    const invalid = ['client', 'vaults', 'invented'];
    expect(await main([...invalid, '--json'])).toBe(2);
    expect(captured.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(captured.stderr.mock.lastCall?.[0]))).toMatchObject({
      ok: false, code: 'INVALID_INPUT', exitCode: 2,
    });
    captured.stderr.mockClear();
    expect(await main(invalid)).toBe(2);
    expect(captured.stderr).not.toHaveBeenCalled();
    expect(captured.stdout.mock.lastCall?.[0]).toContain('Error [INVALID_INPUT]:');
    expect(captured.stdout.mock.lastCall?.[0]).toContain('nanosync client vaults --help');
    expect(await main(['client', 'vaults', '--invalid-flag'])).toBe(2);
    expect(captured.stdout.mock.lastCall?.[0]).toContain('unknown option');
    expect(await main(['--invalid-flag', '--json'])).toBe(2);
    expect(JSON.parse(String(captured.stderr.mock.lastCall?.[0])).code).toBe('INVALID_INPUT');
  } finally { captured.restore(); }
});

test('redirected human output stays readable without ANSI even when FORCE_COLOR is set', () => {
  const captured = capture();
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const prior = process.env.FORCE_COLOR;
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  process.env.FORCE_COLOR = '1';
  try {
    const presentation = new CliOutput(false);
    presentation.command = 'server init';
    presentation.progress('Initializing server…');
    presentation.warning('Keep your recovery secret offline.');
    presentation.result({ initialized: true, serverDirectory: '/private/server' }, 'OK');
    const text = captured.stdout.mock.calls.flat().join('\n');
    expect(text).toContain('Server initialized.');
    expect(text).toContain('Server directory: /private/server');
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('{');
    expect(captured.stderr).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    if (prior === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prior;
    captured.restore();
  }
});

test('terminal capability policy honors NO_COLOR and TERM=dumb', () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;
  const pipe = { isTTY: false } as NodeJS.WriteStream;
  expect(terminalStyle(tty, { TERM: 'xterm' })).toEqual({ color: true, animation: true });
  expect(terminalStyle(tty, { TERM: 'xterm', NO_COLOR: '' })).toEqual({ color: false, animation: true });
  expect(terminalStyle(tty, { TERM: 'dumb', FORCE_COLOR: '1' })).toEqual({ color: false, animation: false });
  expect(terminalStyle(pipe, { FORCE_COLOR: '1' })).toEqual({ color: false, animation: false });
});

test('spinners pause around prompts and stop before persistent output and errors', async () => {
  const captured = capture();
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const term = process.env.TERM;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  process.env.TERM = 'xterm';
  const spinner = {
    text: '', isSpinning: false,
    start() { this.isSpinning = true; return this; },
    stop() { this.isSpinning = false; return this; },
  };
  const createSpinner = spyOn(oraModule, 'default').mockImplementation(() => spinner as Ora);
  const presentation = new CliOutput(false);
  try {
    presentation.progress('Working…');
    expect(spinner.isSpinning).toBe(true);
    await presentation.prompt(async () => { expect(spinner.isSpinning).toBe(false); });
    expect(spinner.isSpinning).toBe(true);
    presentation.info('Verification code: ABC');
    expect(spinner.isSpinning).toBe(false);
    presentation.progress('Waiting…');
    presentation.error('INTERRUPTED', 'Request retained.', 130);
    expect(spinner.isSpinning).toBe(false);
    expect(createSpinner).toHaveBeenCalledTimes(1);
    expect(createSpinner.mock.calls[0]?.[0]).toMatchObject({ stream: process.stdout, discardStdin: false });
    const json = new CliOutput(true);
    json.progress('Must not animate');
    expect(createSpinner).toHaveBeenCalledTimes(1);
  } finally {
    presentation.stop();
    createSpinner.mockRestore();
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
    captured.restore();
  }
});

test('output contexts remain independent across asynchronous calls', async () => {
  const human = new CliOutput(false), json = new CliOutput(true);
  await Promise.all([human, json].map(presentation => withOutput(presentation, async () => {
    await Promise.resolve();
    expect(output()).toBe(presentation);
  })));
});

test('human watch reports changes and recovery but not idle polls or repeated errors', () => {
  const captured = capture();
  try {
    const presentation = new CliOutput(false);
    const first = { revisionId: 'full-revision-id', sequence: 1 };
    presentation.synced(first);
    presentation.synced(first);
    expect(captured.stdout).toHaveBeenCalledTimes(1);
    presentation.syncError(new Error('Server unavailable'));
    presentation.syncError(new Error('Server unavailable'));
    expect(captured.stdout).toHaveBeenCalledTimes(2);
    presentation.synced(first);
    expect(captured.stdout).toHaveBeenCalledTimes(3);
    presentation.synced({ revisionId: 'next-full-revision-id', sequence: 2 });
    expect(captured.stdout).toHaveBeenCalledTimes(4);
    expect(captured.stderr).not.toHaveBeenCalled();
  } finally { captured.restore(); }
});

test('JSON watch retains every event on stderr and a single final stdout result', () => {
  const captured = capture();
  try {
    const presentation = new CliOutput(true);
    const head = { revisionId: 'revision', sequence: 1 };
    presentation.syncProgress('Scanning', true);
    presentation.synced(head);
    presentation.synced(head);
    presentation.syncError(new Error('offline'));
    expect(captured.stderr.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
      { event: 'sync-progress', message: 'Scanning' },
      { event: 'synced', head }, { event: 'synced', head },
      { event: 'sync-error', message: 'offline' },
    ]);
    expect(captured.stdout).not.toHaveBeenCalled();
    presentation.result({ stopped: true }, 'OK');
    expect(captured.stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(captured.stdout.mock.lastCall?.[0]))).toEqual({ ok: true, code: 'OK', data: { stopped: true } });
  } finally { captured.restore(); }
});

test('human diagnostics strip terminal escape sequences and invisible controls', () => {
  expect(readable('\x1b[31mmessage\x1b[0m\x00\u202e')).toBe('message');
});
