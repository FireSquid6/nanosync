#!/usr/bin/env bash
# Run the packaged artifact away from the checkout with no adjacent runtime files.
set -euo pipefail
binary="$(realpath "${1:-dist/nanosync}")"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir "$root/bin" "$root/work"
cp "$binary" "$root/bin/nanosync"
cd "$root/work"
python3 - "$root/bin/nanosync" "$root/work" <<'PY'
import os, re, socket, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
binary, work = map(Path, sys.argv[1:])
env = dict(os.environ, NANOSYNC_PASSWORD='standalone-smoke-password')

def get(port, path):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=2) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers

assets = []
for enabled in (True, False):
    directory = work / ('enabled' if enabled else 'disabled')
    subprocess.run([str(binary), 'server', 'init', '--server-dir', str(directory), '--non-interactive'], env=env, check=True, capture_output=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    command = [str(binary), 'server', 'run', '--server-dir', str(directory), '--port', str(port)]
    if enabled:
        command.append('--web-ui')
    with open(work / 'runtime.log', 'wb') as log:
        proc = subprocess.Popen(command, stdout=log, stderr=log, env=env)
        try:
            for _ in range(100):
                if proc.poll() is not None:
                    raise RuntimeError('runtime exited: ' + (work / 'runtime.log').read_text())
                try:
                    status, body, headers = get(port, '/admin')
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(.05)
            else:
                raise RuntimeError('runtime did not become ready')
            assert status == (200 if enabled else 404), status
            if enabled:
                assert headers['Cache-Control'] == 'no-store'
                assets = re.findall(r'(?:src|href)="(/admin/assets/[^\"]+)"', body.decode())
                assert len(assets) == 2, assets
                for path in assets:
                    status, body, headers = get(port, path)
                    assert status == 200 and len(body) > 0
                    assert 'immutable' in headers['Cache-Control']
                assert get(port, '/admin/assets/absent.js')[0] == 404
            else:
                for path in assets + ['/admin/api/session']:
                    assert get(port, path)[0] == 404, path
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                raise
assert list(binary.parent.iterdir()) == [binary], 'unexpected adjacent files'
print('Standalone smoke passed: isolated binary, embedded HTML/JS/CSS, disabled routes/assets 404')
PY
