import { parseEnrollmentCreateRequest, parseDeviceId } from '@nanosync/protocol';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory, secureRead } from './security.ts';
import { baseUrl } from './url.ts';

export const desktopPendingStage = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.[0-9a-f]{32}\.stage$/;

export function desktopPendingIdentities(root: string): {url:string;alias:string}[] {
  const directory = join(root,'desktop-pending');
  if (!existsSync(directory)) return [];
  return readdirSync(privateDirectory(directory)).filter(name => !desktopPendingStage.test(name)).map(name => {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error('Invalid desktop pending state.');
    const p = JSON.parse(secureRead(join(directory,name),8192).toString());
    if (`${parseDeviceId(p.id)}.json` !== name || typeof p.alias !== 'string') throw new Error('Invalid desktop pending state.');
    return {url:baseUrl(p.url),alias:p.alias};
  });
}

/** Shared wire identity: retries must submit exactly the persisted identity. */
export function enrollmentRequest(deviceId: string, name: string, fingerprint: string) {
  return parseEnrollmentCreateRequest({ protocolVersion: 1, deviceId, displayName: name,
    platform: process.platform, clientVersion: '1', fingerprint });
}
