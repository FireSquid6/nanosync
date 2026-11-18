import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const topics = [
  ['introduction', 'Introduction'], ['installation', 'Installation'],
  ['first-sync', 'Your first sync'], ['server', 'Running a server'],
  ['administration', 'Devices and vaults'], ['ignore-rules', 'Ignoring files'],
  ['troubleshooting', 'Troubleshooting'], ['security', 'Security and recovery'],
] as const;

export function getDocs() {
  return topics.map(([slug, title]) => ({
    slug, title, content: readFileSync(join(process.cwd(), 'content/docs', `${slug}.md`), 'utf8'),
  }));
}
