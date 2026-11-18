import { expect, test } from 'bun:test';
import { createDocSearch } from './search';

test('documentation search finds titles and body text without empty-query noise', () => {
  const search = createDocSearch([
    { slug: 'install', title: 'Installation', content: 'Build with Bun on Linux.' },
    { slug: 'security', title: 'Security', content: 'Keep the recovery secret offline.' },
  ]);
  expect(search('   ')).toEqual([]);
  expect(search('installation')[0]?.slug).toBe('install');
  expect(search('recovery secret')[0]?.slug).toBe('security');
  expect(search('zzzzzzzzzzzzzzzz')).toEqual([]);
});
