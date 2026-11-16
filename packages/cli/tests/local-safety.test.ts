import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/main.ts';

test('protected recovery delivery failure publishes nothing; retry and lost output replay exactly one recoverable vault', async () => {
  const dir = mkdtempSync(join(tmpdir(),'nanosync-delivery-'));
  const old = process.env.NANOSYNC_PASSWORD; process.env.NANOSYNC_PASSWORD = 'delivery-owner-password';
  const out = spyOn(console,'log').mockImplementation(() => {}), err = spyOn(console,'error').mockImplementation(() => {});
  const invoke = (args: string[]) => main([...args,'--server-dir',dir,'--json','--non-interactive']);
  const data = () => JSON.parse(String(out.mock.lastCall?.[0])).data;
  const output = join(dir,'recovery');
  try {
    expect(await invoke(['server','init'])).toBe(0);
    writeFileSync(output,'do not overwrite',{mode:0o600});
    const create = ['server','vaults','create','--name','recoverable','--recovery-output',output];
    expect(await invoke(create)).toBe(2);
    expect(readFileSync(output,'utf8')).toBe('do not overwrite');
    expect(await invoke(['server','vaults','view'])).toBe(0);
    expect(data().vaults).toHaveLength(0);
    // A new protected delivery destination permits a fresh safe attempt.
    const delivered = join(dir,'new-recovery'); create[create.length-1] = delivered;
    out.mockImplementationOnce(() => { throw new Error('lost stdout after durable creation'); });
    expect(await invoke(create)).toBe(2);
    expect(await invoke(['server','vaults','view'])).toBe(0);
    expect(data().vaults).toHaveLength(1);
    const id = data().vaults[0].vaultId;
    const secret = readFileSync(delivered,'utf8');
    expect(statSync(delivered).mode & 0o777).toBe(0o600);
    // The caller lost stdout: identical invocation must return the original vault.
    expect(await invoke(create)).toBe(0);
    expect(data().vaultId).toBe(id);
    expect(readFileSync(delivered,'utf8')).toBe(secret);
    expect(await invoke(['server','vaults','view'])).toBe(0);
    expect(data().vaults).toHaveLength(1);
    expect(out.mock.calls.flat().join('\n')).not.toContain(secret.trim());
    for (const name of readdirSync(join(dir,'owner-creations'))) {
      expect(readFileSync(join(dir,'owner-creations',name),'utf8')).not.toContain(secret.trim());
    }
    // Replay never accepts a substituted recovery file, even once the vault exists.
    writeFileSync(delivered,'substituted',{mode:0o600});
    expect(await invoke(create)).toBe(2);
    expect(await invoke(['server','vaults','view'])).toBe(0);
    expect(data().vaults).toHaveLength(1);
  } finally {
    if (old === undefined) delete process.env.NANOSYNC_PASSWORD; else process.env.NANOSYNC_PASSWORD = old;
    out.mockRestore(); err.mockRestore(); rmSync(dir,{recursive:true,force:true});
  }
});
