#!/usr/bin/env python3
"""Build a public source archive from an explicit allowlist, never the lab tree."""
import hashlib
import json
import re
from pathlib import Path
import shutil
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = 'v0.1.0-preview.2'
NAME = 'ts6-native-sfu-lab-' + VERSION
OUT = ROOT / 'dist'

def main():
    selected = {name: name for name in [
        'LICENSE', 'README.md', 'README.zh-CN.md',
        'RELEASE_NOTES.md', 'RELEASE_NOTES.zh-CN.md',
        'docs/SELFHOST.md', 'docs/SELFHOST.zh-CN.md',
        'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md',
        'deploy/selfhost.env.example', 'deploy/ts6-sfu-selfhost.service',
        'scripts/package-selfhost.py',
        'scripts/instrumentation/extend_control.c',
        'scripts/instrumentation/control_return_code.h',
        'scripts/instrumentation/control_return_code_test.c',
        'media/package.json', 'media/package-lock.json',
        'media/scripts/selfhost.js', 'media/scripts/selfhost-config.js',
        'media/scripts/native-runtime.js', 'media/scripts/query-directory.js',
        'media/scripts/query-snapshot.js', 'media/scripts/browser-test.sh',
        'media/scripts/token.js',
    ]}
    for folder, suffixes in [('media/src', {'.js'}), ('media/test', {'.js'}),
                             ('media/web', {'.js', '.html', '.css'})]:
        for path in (ROOT / folder).rglob('*'):
            if path.is_file() and path.suffix in suffixes and 'dist' not in path.relative_to(ROOT / folder).parts:
                relative = path.relative_to(ROOT).as_posix()
                selected[relative] = relative
    OUT.mkdir(exist_ok=True)
    destination = OUT / NAME
    if destination.exists():
        raise SystemExit(f'Output already exists; choose a new version or move aside {destination}')
    with tempfile.TemporaryDirectory(prefix='ts6-sfu-package-') as temporary:
        stage = Path(temporary) / NAME
        stage.mkdir()
        for target, source in selected.items():
            path = ROOT / source
            if path.is_symlink():
                raise SystemExit(f'Symlink refused: {source}')
            data = path.read_bytes()
            if re.search(rb'/(?:home|Users)/[a-zA-Z0-9_-]+/', data):
                raise SystemExit(f'Personal home directory reference refused: {source}')
            (stage / target).parent.mkdir(parents=True, exist_ok=True)
            (stage / target).write_bytes(data)
        (stage / '.gitignore').write_text(
            'node_modules/\n.env\n.env.*\n!.env.example\n.runtime/\nworker/\n'
            'dist/\nevidence/\nlog/\nlogs/\n*.log\n*.pcap\n*.pcapng\n'
            '*.so\n*.dll\n*.zip\n*.tar.gz\n__pycache__/\n')
        files = sorted(path for path in stage.rglob('*') if path.is_file())
        manifest = {path.relative_to(stage).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
        (stage / 'SOURCE_MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
        shutil.copytree(stage, destination)
        with tarfile.open(OUT / (NAME + '.tar.gz'), 'w:gz') as archive:
            archive.add(stage, arcname=NAME)
        with zipfile.ZipFile(OUT / (NAME + '.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(stage.rglob('*')):
                if path.is_file():
                    archive.write(path, NAME + '/' + path.relative_to(stage).as_posix())
    checksums = []
    for extension in ['.tar.gz', '.zip']:
        path = OUT / (NAME + extension)
        checksums.append(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name)
    (OUT / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
    print(json.dumps({'sourceDirectory': str(destination), 'fileCount': len(manifest) + 1,
                      'archives': [NAME + '.tar.gz', NAME + '.zip']}))

if __name__ == '__main__':
    main()
