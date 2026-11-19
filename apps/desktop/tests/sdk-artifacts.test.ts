import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, verifyArtifacts } from '../../../build/desktop/security';

test('the artifact gate rejects a replaced core or rebuilt-preload drift', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nanosync-sdk-artifacts-'));
  try {
    const source = 'patched artifact';
    writeFileSync(join(directory, 'core.so'), source);
    writeFileSync(join(directory, 'preload.js'), source);
    const files = { 'core.so': digest(source), 'preload.js': digest(source) };
    expect(() => verifyArtifacts(directory, files)).not.toThrow();
    writeFileSync(join(directory, 'preload.js'), 'stock preload');
    expect(() => verifyArtifacts(directory, files)).toThrow('SDK_ARTIFACT_CHANGED');
    writeFileSync(join(directory, 'preload.js'), source);
    writeFileSync(join(directory, 'core.so'), 'stock core');
    expect(() => verifyArtifacts(directory, files)).toThrow('SDK_ARTIFACT_CHANGED');
    expect(() => verifyArtifacts(directory, { '../escape': digest(source) })).toThrow('SDK_ARTIFACT_PATH');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
