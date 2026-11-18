'use client';

import { useState, type CSSProperties } from 'react';

const panes = [
  {
    machine: 'laptop',
    action: '01 / edit, save, upload',
    lines: [
      { at: 0, text: '~/notes $ vim ideas.md', command: true },
      { at: 2, text: '# Weekend plans' },
      { at: 3, text: '- Build something small.' },
      { at: 5, text: ':wq', command: true },
      { at: 6, text: '"ideas.md" written' },
      { at: 7, text: '~/notes $ nanosync client sync', command: true },
      { at: 10, text: '↑ ideas.md · encrypted & uploaded' },
      { at: 11, text: 'Sync complete.' },
    ],
  },
  {
    machine: 'desktop',
    action: '02 / download, open, keep working',
    lines: [
      { at: 12, text: '~/notes $ nanosync client sync', command: true },
      { at: 15, text: '↓ ideas.md · downloaded & decrypted' },
      { at: 16, text: 'Sync complete.' },
      { at: 17, text: '~/notes $ cat ideas.md', command: true },
      { at: 19, text: '# Weekend plans' },
      { at: 20, text: '- Build something small.' },
      { at: 21, text: '~/notes $', command: true },
    ],
  },
];

export function SyncDemo() {
  const [paused, setPaused] = useState(false);
  const [replay, setReplay] = useState(0);

  return <figure className="sync-demo" aria-label="Two-machine file sync demo">
    <div className="terminal-panes" key={replay} data-paused={paused} aria-hidden="true">
      {panes.map(pane => <div className="terminal-pane" key={pane.machine}>
        <div className="terminal-heading"><span>{pane.machine}</span><span>~/notes</span></div>
        <p className="terminal-action">{pane.action}</p>
        <pre><code>{pane.lines.map(line => <span
          key={line.at}
          className={`terminal-line${line.command ? ' terminal-command' : ''}`}
          style={{ '--delay': `${line.at}s` } as CSSProperties}
        >{line.text}{'\n'}</span>)}</code></pre>
      </div>)}
    </div>
    <figcaption>
      Edit and save ideas.md on your laptop. Run nanosync on both machines,
      then open the same file on your desktop. Already-connected folders; illustrative output.
    </figcaption>
    <div className="demo-controls">
      <button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
        Pause animation
      </button>
      <button type="button" onClick={() => {
        setReplay(replay + 1);
        setPaused(false);
      }}>
        Replay animation
      </button>
    </div>
  </figure>;
}
