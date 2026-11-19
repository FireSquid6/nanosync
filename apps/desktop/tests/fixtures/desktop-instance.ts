import { desktopSingleton } from '../../src/singleton';
const [root, runtime] = process.argv.slice(2);
const singleton = await desktopSingleton(root!, 'fixture-session', () => true, runtime);
if (!singleton.primary) throw Error('EXPECTED_PRIMARY');
console.log('ready');
if ((await Bun.stdin.text()).trim() !== 'close') throw Error('FIXTURE_COMMAND');
await singleton.close();
