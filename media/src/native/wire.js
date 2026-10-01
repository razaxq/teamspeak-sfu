// Beta4.1 native envelope inferred from hash-matched serializer/deserializer code.
// This module performs NO authentication and is not a native network endpoint.
export const PROFILE = Object.freeze({
  clientVersion: '6.0.0-beta4.1',
  dllSha256: 'a302bcc4c6ed341ecb922d0e3c29201f5bb385705edbd6f6d6e227eb7b505198',
  evidence: 'static-disassembly',
  runtimeVerified: false,
});
export const COMMANDS = Object.freeze([
  'create-stream', 'transport-connect', 'transport-produce', 'set-paused',
  'join-request', 'join-response', 'consume-stream', 'close-stream',
  'main-producer-changed', 'close-consumer-producer', 'update-codec-support',
]);
const known = new Set(COMMANDS);
const own = (object, key) => Object.hasOwn(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
export class WireError extends Error {
  constructor(code) { super(code); this.name = 'WireError'; this.code = code; }
}
function check(condition, code) { if (!condition) throw new WireError(code); }
function checkTree(value, depth = 0, seen = new Set()) {
  check(depth <= 32, 'NESTING_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'NON_JSON_VALUE'); return; }
  check(typeof value === 'object', 'NON_JSON_VALUE');
  check(!seen.has(value), 'CYCLIC_VALUE'); seen.add(value);
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'NON_JSON_VALUE');
  for (const entry of Object.values(value)) checkTree(entry, depth + 1, seen);
  seen.delete(value);
}
function shape(value) {
  check(object(value), 'INVALID_ENVELOPE');
  if (own(value, 'responseId')) {
    check(!own(value, 'cmd') && !own(value, 'requestId') && !own(value, 'token'), 'AMBIGUOUS_ENVELOPE');
    check(id(value.responseId), 'INVALID_RESPONSE_ID');
    check(Number.isInteger(value.err) && value.err >= -2147483648 && value.err <= 2147483647, 'INVALID_ERROR_CODE');
    return { type: 'response', responseId: value.responseId, err: value.err,
      ...(own(value, 'args') ? { args: value.args } : {}) };
  }
  check(typeof value.cmd === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.cmd), 'INVALID_COMMAND');
  check(!own(value, 'err') && id(value.requestId), 'INVALID_REQUEST_ID');
  // The client serializer includes token. Server-to-client parsing does not
  // establish its presence; direction-specific authentication is the caller's job.
  check(!own(value, 'token') || (typeof value.token === 'string' && value.token.length <= 8192), 'INVALID_TOKEN_FIELD');
  check(own(value, 'args'), 'MISSING_ARGS');
  return { type: 'request', cmd: value.cmd, requestId: value.requestId,
    ...(own(value, 'token') ? { token: value.token } : {}), args: value.args,
    recognized: known.has(value.cmd) };
}
export function decodeFrame(input, { maxBytes = 65536 } = {}) {
  check(typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array, 'INVALID_FRAME');
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  check(bytes.byteLength <= maxBytes, 'FRAME_TOO_LARGE');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new WireError('INVALID_JSON'); }
  checkTree(value); return shape(value);
}
export function encodeRequest({ cmd, requestId, token, args }) {
  const value = { cmd, requestId, ...(token === undefined ? {} : { token }), args };
  checkTree(value); shape(value);
  const text = JSON.stringify(value); check(Buffer.byteLength(text) <= 65536, 'FRAME_TOO_LARGE');
  return text;
}
export function encodeResponse({ responseId, err, args }) {
  const value = { responseId, err, ...(args === undefined ? {} : { args }) };
  checkTree(value); shape(value);
  const text = JSON.stringify(value); check(Buffer.byteLength(text) <= 65536, 'FRAME_TOO_LARGE');
  return text;
}
// Safe for logs: no token, request/response ID, identity, RTP, or args values.
export function summarizeFrame(frame) {
  return frame.type === 'response'
    ? { envelope: 'response', err:frame.err, hasArgs: own(frame, 'args') }
    : { envelope: 'request', command: known.has(frame.cmd) ? frame.cmd : '[UNKNOWN]',
      hasToken: own(frame, 'token'), hasArgs: own(frame, 'args') };
}
