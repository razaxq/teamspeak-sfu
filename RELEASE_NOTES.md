# v0.1.0-preview.1

**English** | [简体中文](RELEASE_NOTES.zh-CN.md)

The first experimental preview for self-hosting, supporting Linux ARM64 only.

Implemented the official client's server screen-sharing entry, start/stop notifications, viewing approval, and video forwarding. A user confirmed that official, unmodified clients can view shared screen video.

The self-hosting entry point is independent of the development host. It supports configurable hostnames, ports, container names, data volumes, and state directories. Installation verifies the pinned TeamSpeak server's SHA-256 and compiles the extension from this project's C source. The repository includes a systemd unit and English and Simplified Chinese deployment guides.

Recommended for people with software development experience, or people familiar with using **Codex** for development, deployment, and troubleshooting.

Known limitations:

- Shared audio does not work, and viewers have no shared-audio volume control. Normal voice chat uses a separate path.
- The only verified client is Windows 6.0.0-beta4.1, build 1779880475.
- Only the pinned ARM64 server build is supported. Do not substitute `latest` or an arbitrary image.
- A separate experimental TeamSpeak server is required. Changing the SFU Endpoint on an ordinary server is insufficient.
- Public IPv4, rootful Podman, and iptables are required. TURN, WSS, IPv6, and x86_64 deployment are not supported.
- Capacity and long-term stability remain at the preview stage.

Follow the [self-hosting guide](docs/SELFHOST.md). This version is a GitHub **Pre-release**.

Release preparation checks (2026-10-01): `npm ci --omit=dev` succeeded from a clean source package, and all 68 automated tests passed. An isolated ARM64 instance passed startup with strict permissions, sharing notification connection, restart with retained credentials and data volume, duplicate-launch rejection, and normal shutdown cleanup. Shutdown retained persistent data. This package has not undergone a fresh end-to-end test between two official clients; video status is based on the earlier user confirmation.
