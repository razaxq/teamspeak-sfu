# v0.1.0-preview.2

**English** | [简体中文](RELEASE_NOTES.zh-CN.md)

Connected ordinary TeamSpeak users can now publish screen shares without joining the administrator group or using an administrator privilege key. The generated administrator key remains available for server management.

Changes:

- Removed the hard-coded administrator group requirement from the trusted client directory and Query integration.
- Group changes alone no longer revoke a user's stream identity. Disconnects, channel moves, identity changes, and Query loss still revoke it.
- The internal notification connection remains excluded from publishing and viewing.
- Kept authenticated connection checks, stream ownership, same-channel viewing, viewing approval, and capacity limits.
- Updated the runtime instructions and the English and Chinese documentation. English is the default; detailed README and contributor guides are included.

Validation: all **70 automated tests passed**. An isolated pinned ARM64 server was tested with synthetic native-protocol publisher and viewer connections, both verified not to belong to administrator group 6. The test passed stream start/stop notifications, sharing flags, late-join discovery, viewing approval, audio/video consumer creation, viewer count, and cleanup. This is a protocol integration test, not a new official desktop-client acceptance test or proof of working shared audio.

Known limitations remain: screen video was previously confirmed between official Windows **6.0.0-beta4.1, build 1779880475** clients; shared audio and its volume controls still do not work. Only the pinned Linux ARM64 server build is supported. A separate experimental TeamSpeak server, public IPv4, rootful Podman, and iptables are required. TURN, WSS, IPv6, and x86_64 deployment are not supported. Large deployments and long-term unattended operation remain unverified.

Recommended for people with software development experience or familiarity with **Codex** for development, deployment, and troubleshooting. Follow the [self-hosting and upgrade guide](docs/SELFHOST.md). This is an experimental **Pre-release**.
