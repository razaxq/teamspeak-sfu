# TeamSpeak SFU

**English** | [简体中文](README.zh-CN.md)

An experimental, self-hosted SFU that lets **unmodified official TeamSpeak 6 clients** share screen video through a server.

**Current status: screen video has been verified between official clients. Shared audio does not work, and viewers have no shared-audio volume control. The server requires Linux ARM64 and a pinned TeamSpeak server build.**

> **Recommended audience:** people with software development experience, or people familiar with using **Codex** to assist with development, deployment, and troubleshooting. This is an experimental project that requires reading instructions, configuring a Linux server, and diagnosing compatibility or network issues. It is not yet a turnkey installation for nontechnical users. If you use Codex, be prepared to review its changes and verify the result on your own server.

[Self-hosting guide](docs/SELFHOST.md) · [Downloads](https://github.com/razaxq/teamspeak-sfu/releases) · [Release notes](RELEASE_NOTES.md) · [Report an issue](https://github.com/razaxq/teamspeak-sfu/issues)

## What this project does

An SFU (Selective Forwarding Unit) receives a publisher's media and forwards it to viewers. This project combines a TeamSpeak server extension, native signaling, and a mediasoup media service to make the official client's **Server** screen-sharing mode usable in an experimental deployment.

Deployers run the server components on their own infrastructure. Publishers and viewers use the original TeamSpeak client; no client patch or replacement is required. Clients do not need public IP addresses.

**You must deploy the accompanying experimental TeamSpeak server. Simply entering this project's address in an arbitrary existing server's SFU Endpoint field is not sufficient.** The deployment creates a separate server instance, with its own credentials and data volume.

## Features and current status

| Capability | Status |
| --- | --- |
| Official-client screen-sharing entry and sharing icon | Implemented |
| Start/stop notifications and viewing approval | Implemented |
| Screen video between unmodified official clients | Confirmed by a user |
| Shared audio and the viewer's shared-audio volume control | **Not working** |
| Normal TeamSpeak voice chat | Reported working; separate from shared audio |
| Publishing by ordinary connected users | Supported; no administrator group required |
| Configurable public host, ports, container, volume, and state directory | Implemented |
| Pinned server verification and local extension compilation | Implemented |
| Credentials and data retained across normal restarts | Verified in an isolated deployment |
| x86_64 servers and other client/server builds | Not supported or not verified |
| Large deployments and long-term unattended operation | Not verified |

The tested official client is **TeamSpeak 6.0.0-beta4.1 for Windows, build 1779880475**. Compatibility with other versions is not established.

The media core has automated and browser audio/video tests, but these do **not** establish working shared audio in the official client. See the [release notes](RELEASE_NOTES.md) for the scope of validation.

## How it works

| Component | Role |
| --- | --- |
| Pinned TeamSpeak server and this project's C extension | Expose the native streaming control path and connect it to the SFU service |
| Node.js native signaling service | Handle stream access, publisher/viewer permissions, viewing approval, and notifications |
| mediasoup | Receive and forward WebRTC media |
| Original TeamSpeak clients | Publish screens and join streams through the client UI |

The extension relies on a specific ARM64 server binary layout. Startup checks the server's SHA-256 and compiles the extension locally. Do not replace the pinned image with `latest` or automatically upgrade it.

A connection named `SFU 服务` (SFU service) delivers native sharing notifications inside the experimental server. It consumes one connection slot and should remain connected.

## Requirements

- **Linux ARM64 / aarch64** server with a public IPv4 address.
- Root access, systemd, **rootful Podman**, iptables, GCC, and **Node.js 22+**.
- Python 3.10+, pip, and a C++ compiler if mediasoup needs a local worker build.
- A hostname whose A record points directly to the server, or the public IPv4 address itself.
- Access to the pinned upstream TeamSpeak image and npm dependencies.
- The tested official client version for the best chance of reproducing current results.

Default ports:

| Port | Protocol | Purpose |
| --- | --- | --- |
| 19987 | UDP | TeamSpeak connections and voice |
| 18344 | TCP | Native SFU WebSocket signaling |
| 19125 | UDP and TCP | WebRTC media |
| 11022 | TCP, loopback only | Internal SSH Query; do not expose publicly |

The current deployment uses direct IPv4 connections and Podman's default bridge network. It does not provide WSS, TURN, IPv6, rootless, or reverse-proxy deployment instructions.

## Getting started

Follow the **[complete self-hosting guide](docs/SELFHOST.md)** for commands and configuration. The installation sequence is:

1. Download the source package from [Releases](https://github.com/razaxq/teamspeak-sfu/releases) and extract it to `/opt/ts6-native-sfu-lab`.
2. Install the system dependencies and npm production dependencies.
3. Copy the example configuration, set your public hostname/IP, and accept the TeamSpeak server license after reading it.
4. Pull the pinned server image and run the preflight check to verify the binary and compile the extension.
5. Open the required cloud/firewall ports, install the systemd unit, and start the service.
6. Confirm readiness in `status.json`, then read the generated connection details and administrator privilege key locally.

Passwords, keys, and state are created on the deploying server. No shared credentials are included in the repository.

## Sharing and viewing

1. Both users connect to the experimental TeamSpeak server and join the same channel.
2. Any connected ordinary user can publish; no administrator group membership or privilege key is required. Keep the administrator key for server management only.
3. The publisher opens screen sharing, selects **Server**, and starts the stream.
4. The viewer joins through the sharing icon; the publisher approves the request when prompted.

The deployment configures the SFU Endpoint automatically. Viewers do not need administrator permissions. **Expect video only for screen sharing in this preview.**

The native SFU no longer imposes the old 8-connection, 4-stream, or 16-viewer quotas. A viewer limit of `0` means no SFU-imposed cap; an explicit positive limit chosen for a stream is respected. Credentials remain valid for the current TeamSpeak connection instead of expiring after one hour. Disconnects, channel moves, credential rotation, and loss of the trusted client directory still revoke access.

TeamSpeak has its own slot setting and license ceiling. The [upstream Beta server includes 32 slots](https://github.com/teamspeak/teamspeak6-server#readme), one of which is occupied by the notification service. This release does not bypass that limit. One active stream per TeamSpeak connection remains because native stream-info lookup identifies the publisher by client ID. Removing SFU quotas is not a claim of unlimited hardware capacity or a load-test result.

## Operations and limitations

TeamSpeak data is stored in the Podman volume `ts6-sfu-selfhost-data`; credentials and extension state are stored in `/var/lib/ts6-sfu-selfhost/`. Back them up together. Normal restarts preserve them. Do not upload credentials, the state directory, or unreviewed logs to public issues.

The deployment manages its own host firewall rules and removes them on a normal stop. It does not configure cloud security groups. Abnormal termination may leave a container or firewall rules that require manual inspection. See [maintenance and troubleshooting](docs/SELFHOST.md#maintenance-and-troubleshooting).

This is a **community experiment, not an official TeamSpeak product**. The preview is intended for testing and feedback. Shared audio, support for more architectures and versions, recovery behavior, and long-running stability still need work.

## Repository layout

| Path | Contents |
| --- | --- |
| `media/src/` | Media core and native signaling implementation |
| `media/scripts/` | Self-hosting entry point, preflight, and Query integration |
| `media/test/` | Automated tests and browser test clients |
| `scripts/instrumentation/` | Source for the pinned server extension |
| `scripts/package-selfhost.py` | Public source packaging using an explicit file allowlist |
| `deploy/` | Configuration example and systemd unit |
| `docs/` | English and Simplified Chinese deployment guides |

## Development and contributing

After installing the required system dependencies:

```sh
cd media
npm ci
npm test
```

Release preparation passed 77 automated tests and an isolated installation/startup/restart/shutdown check. A fresh end-to-end test between two official clients was not repeated for the deployment package; video support is based on the earlier user confirmation.

Useful contributions include shared-audio support and volume controls, x86_64 server compatibility, installation reliability, recovery after abnormal shutdown, and long-running tests. For issue reports, include your server architecture, operating system, full client version, publisher/viewer role, reproduction steps, and sanitized diagnostics.

English is the default documentation language. Keep the corresponding `*.zh-CN.md` files in sync when changing behavior or instructions. See the [contribution guide](CONTRIBUTING.md) for reporting issues, validating changes, documentation, and source packaging.

## License

Project source is licensed under [MIT](LICENSE). TeamSpeak software is obtained separately from the upstream image and remains subject to its own license. Third-party dependencies retain their respective licenses. This repository and its source packages do not include official TeamSpeak binaries, account credentials, or logs from live testing.
