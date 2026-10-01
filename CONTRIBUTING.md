# Contributing

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

Contributions are welcome. This experimental project is best suited to people with software development experience, or people familiar with using **Codex** for development and troubleshooting. Start with the [README](README.md) for the supported configuration and known limitations, or the [self-hosting guide](docs/SELFHOST.md) to deploy a test instance.

## Report an issue

Include:

- Server operating system and architecture.
- Full TeamSpeak client version and build number.
- Whether the problem occurs for the publisher, viewer, or both.
- Steps to reproduce, expected behavior, and actual behavior.
- Relevant sanitized diagnostics and whether the issue also occurs with P2P sharing.

Shared audio and its volume control are already known to be unavailable. Additional reproducible evidence is useful, but media traffic alone does not establish that the official client can play audio.

Review logs before sharing. Remove passwords, administrator privilege keys, tokens, user UIDs, and personal addresses. Do not upload `access.txt`, `server.env`, state directories, full client installations, or raw container startup logs.

## Develop and verify changes

Use a separate test instance and the pinned server image described in the deployment guide. The native extension depends on the supported ARM64 server build; do not apply its offsets to other builds.

After installing the system dependencies:

```sh
cd media
npm ci
npm test
```

The automated suite covers authentication, revocation, native signaling, viewing approval, media cleanup, and deployment configuration. Optional browser tests also need Playwright Chromium and built web assets. State exactly what was tested; browser success does not replace acceptance testing between official clients.

Keep pull requests focused. Describe the problem, the resulting behavior, validation performed, and remaining limitations. If using Codex, review generated changes and report the checks you actually completed.

Useful areas for contributions include official-client shared audio and volume controls, x86_64 support, installation reliability, recovery after abnormal shutdown, and long-running stability.

## Documentation

English is the default. Update both languages when behavior or instructions change:

| English | 简体中文 |
| --- | --- |
| [README](README.md) | [README](README.zh-CN.md) |
| [Self-hosting](docs/SELFHOST.md) | [自行部署](docs/SELFHOST.zh-CN.md) |
| [Contributing](CONTRIBUTING.md) | [贡献指南](CONTRIBUTING.zh-CN.md) |
| [Release notes](RELEASE_NOTES.md) | [发布说明](RELEASE_NOTES.zh-CN.md) |

Keep commands, configuration names, pinned versions, and capability limitations consistent. Put project overview and navigation in the README, operational steps in the self-hosting guide, and version-specific changes and validation in the release notes.

## Source packaging

From the repository root:

```sh
python3 scripts/package-selfhost.py
```

This writes a clean source directory, ZIP, tar.gz, and SHA256SUMS under `dist/`. It uses an explicit allowlist and includes both documentation languages. Each package contains `SOURCE_MANIFEST.json` with source-file SHA-256 hashes.

Before running it again, move previous outputs aside or update the script's version for a new release. Review the selected files and generated manifest; do not archive an entire development workspace. Exclude credentials, runtime state, logs, downloaded upstream binaries, and dependency directories.

Changes on the default branch do not alter previously published release archives or tags. Document fixes in the repository can therefore be newer than the documentation bundled with an older release.
