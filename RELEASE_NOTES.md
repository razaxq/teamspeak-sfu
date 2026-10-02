# Unreleased

- Handle viewer `close-consumer-producer` requests with ownership checks and idempotent cleanup. Previously this unsupported command disconnected the viewer. A viewer cannot close a publisher or another viewer's consumer.
- Add a default-off audio-track refresh experiment (`SFU_EXPERIMENTAL_AUDIO_REFRESH=1`). Refresh only once per viewing session and accept old-consumer cleanup both before and after replacement. This is **not a confirmed fix for official-client shared audio**.
- Serialize deferred viewer notifications and update the runtime status atomically with current Query/relay health and a timestamp.

Validation: **91 automated tests passed**. Real Chromium ICE/DTLS/SRTP tests with two viewers decoded AV1 video and Opus audio, verified independent pause/resume and complete cleanup, both with refresh enabled and disabled. Each viewer refreshed its audio consumer exactly once in the enabled test. A deployed protocol smoke test also passed discovery, admission, audio refresh, repeated old-consumer cleanup and stop cleanup with three synthetic non-admin clients; that test sent no real media. Official-client audio and volume controls still require user acceptance testing.

# v0.1.0-preview.5

**English** | [简体中文](RELEASE_NOTES.zh-CN.md)

Protect the notification connection from a client-ID reassignment defect in the pinned TeamSpeak SDK, and resolve the earlier 12-client test failure.

The SDK treats a nickname followed by digits as a possible match for its own nickname. In the old test, `Discovery probe 10` and similar names caused `Discovery probe 1` to adopt another client's ID. Its subsequent access-info request timed out. Using distinct names passed the same test; retaining the original names with the identity guard also passed.

- Bind the relay's SDK and outgoing packet client IDs to the server's `initserver` assignment. Later nickname announcements cannot replace that assignment.
- Require a valid server assignment before relay readiness. The trusted Query directory continues to bind the assigned ID to its UID and connection session.
- Add regression tests using the actual pinned SDK, including a reproduction without the guard and conflicting announcements in the same frame as initialization.

Validation: **88 automated tests passed**. An isolated test with **12 synthetic clients** admitted one publisher and **11 viewers**, created **22 AV1/Opus consumers**, verified the viewer count, and completed pause/resume, leave and stop cleanup. The test retained the previously conflicting nicknames with the guard enabled. This is a signaling and resource-lifecycle check: it did not send real screen media, test 11-viewer playback, measure bandwidth capacity, or repeat official desktop-client acceptance.

Shared audio and its volume controls remain unavailable. Linux ARM64 and the pinned server build remain required. Long-term stability and large-scale media capacity remain unverified. The prior quota removals and authorization checks are unchanged.

See the [upgrade guide](docs/SELFHOST.md#upgrade-from-preview1-through-preview4).

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

See the [upgrade guide](docs/SELFHOST.md).

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
