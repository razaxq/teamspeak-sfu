# Self-hosting the experimental SFU

**English** | [简体中文](SELFHOST.zh-CN.md)

This is **v0.1.0-preview.4**. A user has confirmed shared screen video between unmodified official TeamSpeak 6 clients. **Shared audio does not work, and viewers have no shared-audio volume control.** Normal voice chat uses a separate path. Browser audio/video tests do not establish official-client shared-audio support.

This project is recommended for people with software development experience, or people familiar with using **Codex** for development, deployment, and troubleshooting. Be prepared to configure Linux networking, inspect diagnostics, and verify changes on your own server.

Only **Linux ARM64 / aarch64** with the pinned TeamSpeak server image is supported. The tested official Windows client is **6.0.0-beta4.1, build 1779880475**. x86_64 servers, other client versions, large rooms, and long-term unattended operation have not been verified.

Deployment creates a separate experimental TeamSpeak server with this project's server-side extension. **Setting an SFU Endpoint on an ordinary existing server is insufficient.** Clients remain unmodified. The extension depends on a specific binary layout; startup verifies the SHA-256. Do not automatically upgrade the server image.

## Prepare the server

Use an ARM64 Linux server with public IPv4, root access, systemd, rootful Podman, iptables, GCC, and Node.js 22+. The scripts use IPv4, direct WebSocket connections, and Podman's default bridge network. Reverse-proxy, WSS, TURN, IPv6, and rootless deployment are not provided.

These dependency commands apply to Debian / Ubuntu; install equivalent packages on other distributions. Install Node.js separately in the system PATH, such as `/usr/bin/node` or `/usr/local/bin/node`. A Node.js installation available only through one user's nvm environment is insufficient for the systemd unit.

```sh
sudo apt-get update
sudo apt-get install -y podman iptables build-essential python3 python3-pip ca-certificates
uname -m
node --version
```

`uname -m` must report `aarch64`. Dependency installation downloads a mediasoup worker or attempts a local build if a suitable binary is unavailable. Local builds need Python 3.10+, pip, and a C++ compiler. See the [mediasoup installation documentation](https://mediasoup.org/documentation/v3/mediasoup/installation/).

Extract the source package to `/opt/ts6-native-sfu-lab`, directly containing `media/`, `deploy/`, and `scripts/`. Run the following commands as root:

```sh
mkdir -p /opt/ts6-native-sfu-lab
tar -xzf ts6-native-sfu-lab-v0.1.0-preview.4.tar.gz --strip-components=1 -C /opt/ts6-native-sfu-lab
cd /opt/ts6-native-sfu-lab
npm --prefix media ci --omit=dev
install -m 600 deploy/selfhost.env.example /etc/ts6-sfu-selfhost.env
```

Edit `/etc/ts6-sfu-selfhost.env`. Set `SFU_PUBLIC_HOST` to your hostname or public IPv4. A hostname's A record must point directly to this server; disable any CDN proxy. Supply only the hostname, without `http://`, a port, or a path. Read the TeamSpeak server license terms, then set `TSSERVER_LICENSE_ACCEPTED` to `accept` if you accept them. Other settings can retain their defaults.

Pull the pinned image:

```sh
podman pull docker.io/teamspeaksystems/teamspeak6-server@sha256:a89b53db7b4a213251a47b652b212d1314728ec8c498f5246cf7e7622587ed89
node --env-file=/etc/ts6-sfu-selfhost.env media/scripts/selfhost.js --check
```

The check creates and removes a temporary container without starting it, verifies the server binary, and compiles this project's extension. It does not start the voice server. Expected output includes `preflight: passed`. Deployers obtain official software from upstream; the source package contains no TeamSpeak executables or client DLLs.

## Open ports and start the service

Allow these ports in your cloud security group and upstream firewall, using your configured values if changed:

| Default port | Protocol | Purpose |
| --- | --- | --- |
| 19987 | UDP | TeamSpeak connections and voice |
| 18344 | TCP | Native SFU WebSocket signaling |
| 19125 | UDP and TCP | WebRTC media |
| 11022 | TCP, loopback only | Internal SSH Query; do not expose publicly |

The script inserts the host iptables rules needed by this instance and removes them on a normal stop. It does not modify cloud security groups. Administrators of hosts with strict network policies should review these rules against their requirements. Clients do not need public IP addresses.

```sh
install -m 644 deploy/ts6-sfu-selfhost.service /etc/systemd/system/ts6-sfu-selfhost.service
systemctl daemon-reload
systemctl enable --now ts6-sfu-selfhost
systemctl status ts6-sfu-selfhost --no-pager
cat /var/lib/ts6-sfu-selfhost/status.json
```

First startup takes several tens of seconds. Once `ready` and `viewerDiscoveryReady` in `status.json` are both `true`, read the credentials locally:

```sh
cat /var/lib/ts6-sfu-selfhost/access.txt
```

This file contains the server password and a single-use administrator privilege key, with permissions `0600`. It is intended for the administrator; ordinary users need only the server address and connection password. Do not upload this file, `server.env`, the state directory, or unreviewed logs to a public repository.

The current runtime writes Chinese labels in `access.txt`: `实验地址` means server address, `服务器密码` means server password, and `一次性管理员权限密钥` means single-use administrator privilege key.

## Use the official client

1. Connect publisher and viewer to `PUBLIC_IPV4:19987` and enter the generated server password. Specify the port explicitly to avoid DNS SRV records directing you elsewhere.
2. Connected ordinary users can publish without an administrator privilege key. The key in `access.txt` is only for server administration; do not grant administrator privileges just to enable sharing.
3. Join the same channel. The publisher opens screen sharing, selects **Server**, and starts the stream.
4. The viewer joins through the active sharing icon. The publisher approves the request when prompted.

The script automatically sets SFU Endpoint to `SFU_PUBLIC_HOST:SFU_WS_PORT`. A connection named `SFU 服务` (SFU service) provides sharing notifications; keep it connected. If it disconnects, the runtime attempts to reconnect it on the next discovery poll (normally every five seconds). Successful delivery steps are retained across this reconnect, while failed steps are retried. This does not recover a publisher or viewer whose own TeamSpeak connection was lost. The native SFU has no fixed total connection/room quota, and `viewer_limit=0` no longer becomes 16. Positive per-stream viewer limits are still honored. TeamSpeak itself retains its configured slot count and license ceiling; the [upstream Beta license provides 32 slots](https://github.com/teamspeak/teamspeak6-server#readme). The notification connection uses one slot. One active stream per TeamSpeak connection and per-request protocol protections remain. No large-scale capacity claim is made.

Credentials are now connection-bound with no one-hour expiry. Disconnects, channel moves, credential rotation, or Query loss still revoke access. `SFU_TS_MAXCLIENTS=0` (the default) preserves TeamSpeak's own slot setting. When upgrading an older generated instance still at 8 slots, the launcher migrates it to 32 once and records that migration in the state directory. Later changes through TeamSpeak are preserved. A positive `SFU_TS_MAXCLIENTS` explicitly sets slots at startup, subject to TeamSpeak's own limits; it does not mean unlimited slots.

## Maintenance and troubleshooting

```sh
systemctl stop ts6-sfu-selfhost
systemctl start ts6-sfu-selfhost
```

TeamSpeak data lives in the Podman volume `ts6-sfu-selfhost-data`. Credentials and extension state live in `/var/lib/ts6-sfu-selfhost/`. Back up both together. Normal restarts reuse data and passwords without generating a new administrator key. A used key remains visible in the file but cannot be reused. Do not delete the data volume to troubleshoot connection problems.

If the service is running but not ready, check `status.json`, then inspect `journalctl -u ts6-sfu-selfhost -n 50 --no-pager` locally. Do not publish raw container startup logs: they may contain privilege keys.

- `Unsupported ...`: architecture or image mismatch. Use the pinned image in this guide.
- `Deployment command failed`: check dependencies, image availability, free ports, and directory permissions.
- Container already exists: the script will not take over an existing container. Check whether it is left over from this project's abnormal shutdown, and stop the owning service before handling it. Do not delete unknown containers.
- No sharing entry: confirm that the client is connected to the updated experimental server, reconnect, join the same channel, and check `viewerDiscoveryReady`.
- Voice works but viewing fails: check 18344/TCP, 19125/UDP and TCP, and the DNS A record. No TURN relay is available.
- Video works but shared audio and its volume control are missing: this is a known limitation.

To uninstall, run `systemctl disable --now ts6-sfu-selfhost`, remove the unit, and run `systemctl daemon-reload`. The data volume and state directory are retained. Power loss or forced termination can leave containers or iptables rules bearing the instance name; inspect them before manual cleanup.

## Development checks

```sh
cd /opt/ts6-native-sfu-lab/media
npm ci
npm test
```

Tests cover authentication, permission revocation, native messages, viewing approval, media cleanup, and deployment configuration validation. Optional browser tests need Playwright Chromium and built web assets. They do not replace end-to-end acceptance testing between two official clients.

## Upgrade from preview.1, preview.2, or preview.3

Stop this project's systemd service, update the application directory with the preview.4 source, rerun `npm --prefix media ci --omit=dev` and the preflight check, then start the service. Retain `/etc/ts6-sfu-selfhost.env`, the state directory, and the Podman data volume. Reconnect clients to use the updated policy; no administrator key is needed.
