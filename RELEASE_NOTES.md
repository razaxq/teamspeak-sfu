# v0.1.0-preview.4

**English** | [简体中文](RELEASE_NOTES.zh-CN.md)

Improved recovery of sharing icons and start/stop announcements when notification delivery fails or the notification service reconnects.

- A failed recipient no longer prevents synchronization attempts for later recipients.
- Track each notification step. Retry incomplete steps without repeating confirmed ones; clear a possibly delivered sharing icon when its stream stops, even if the original acknowledgement was lost.
- Recheck the recipient connection between the icon update and the stream announcement. Do not announce a stream that stopped during an earlier send.
- Coalesce bursts of start/stop events into current-state synchronization instead of queuing a full scan for every event.
- Stop sending through an unhealthy relay and retain delivery progress when replacing its connection.

Validation: **84 automated tests passed**. An isolated test with three non-admin synthetic protocol clients passed discovery, late arrival, viewing approval, AV1/Opus consumer creation, pause/resume, and stop cleanup. Forcibly disconnecting the notification service verified automatic reconnection without duplicate start announcements to existing viewers. The pinned server binary was verified and the C extension compiled locally. No official desktop-client acceptance test was repeated.

Shared audio and its volume controls remain unavailable. The earlier 12-client full-flow timeout is still unresolved; this release does not establish large-room or long-term stability. Linux ARM64 and the pinned server build remain required. The quotas removed in preview.3 remain removed, and its authorization and upstream TeamSpeak slot constraints still apply.

See the [upgrade guide](docs/SELFHOST.md#upgrade-from-preview1-preview2-or-preview3).

# v0.1.0-preview.3

**English** | [简体中文](RELEASE_NOTES.zh-CN.md)

Removed the native SFU's fixed total connection, room, stream, credential-count, and default viewer quotas. Ordinary connected users can still publish without administrator privileges.

Changes:

- Removed the native deployment's 8-connection/media-session and 4-room/stream caps.
- `viewer_limit=0` now means no SFU-imposed viewer cap instead of being rewritten to 16. An explicit positive limit selected for a stream is still honored.
- Removed internal four-stream viewer-grant and 128-credential quotas.
- Credentials follow the authenticated TeamSpeak connection and no longer force a media shutdown after one hour. Disconnects, channel moves, identity changes, credential rotation, and Query loss still revoke access.
- Stopped resetting TeamSpeak to 8 slots on every start. Existing generated eight-slot instances migrate to 32 once; subsequent slot changes are preserved. `SFU_TS_MAXCLIENTS=0` retains the TeamSpeak setting, while a positive value requests a particular slot count.
- Added status fields for the effective TeamSpeak slot count and the connection-bound credential lifetime.

The [upstream TeamSpeak Beta server has a 32-slot license](https://github.com/teamspeak/teamspeak6-server#readme). This release does not bypass its slot/license ceiling. The notification service uses one slot. One active stream per TeamSpeak connection remains because native stream-info lookup identifies streams by publisher client ID. Authentication, same-channel viewing, publisher approval, and per-request protocol/abuse protections remain in place. Removing quotas is not a hardware-capacity guarantee.

Validation: **77 automated tests passed**, including 12 simultaneous native WebSocket/media sessions, more than four streams, 21 viewer reservations, 140 credentials, and continued publisher/viewer media operations after a **simulated** two-hour clock advance. Tests also verify revocation and TeamSpeak slot migration. An isolated native protocol smoke test also passed stream discovery, approval, consumer creation, pause/resume, and cleanup with three non-admin clients. A separate 12-client connection attempt reached 12 connections but timed out during the subsequent media flow; that larger end-to-end case remains unverified. These checks do not constitute a large-scale load test or a fresh official desktop-client acceptance test.

Known limitations: the pinned Linux ARM64 server is still required; the tested official Windows client is **6.0.0-beta4.1, build 1779880475**. Shared audio and its volume controls remain unavailable. TURN, WSS, IPv6, and x86_64 deployment are not supported. Long-term stability is not established.

Recommended for people with software development experience or familiarity with **Codex** for development and troubleshooting. See the [self-hosting and upgrade guide](docs/SELFHOST.md). This is an experimental **Pre-release**.
