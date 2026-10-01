import { decodeFrame, encodeResponse, WireError } from './wire.js';

// Explicit authorization boundary for future TS integration. No experimental
// HMAC fallback, token decoding shortcut, or hard-coded native error codes.
export function createNativeDispatcher({ authorize, handlers = new Map() } = {}) {
  if (!(handlers instanceof Map)) throw new TypeError('handlers must be a Map');
  return async input => {
    const request = decodeFrame(input);
    if (request.type !== 'request') throw new WireError('EXPECTED_REQUEST');
    if (!request.recognized) throw new WireError('UNSUPPORTED_COMMAND');
    if (typeof authorize !== 'function') throw new WireError('NATIVE_AUTH_UNAVAILABLE');
    // Trusted verifier must bind the token + command + args to the real
    // server/channel/stream/client/role. It must recheck expiry/revocation.
    const principal = await authorize(request);
    if (!principal) throw new WireError('NATIVE_AUTH_REJECTED');
    const handler = handlers.get(request.cmd);
    if (typeof handler !== 'function') throw new WireError('NATIVE_HANDLER_UNAVAILABLE');
    const result = await handler({ principal, args: request.args });
    if (!result || !Number.isInteger(result.err)) throw new WireError('INVALID_HANDLER_RESULT');
    // The handler supplies a verified protocol error code, including success.
    // We do not guess which native codes correspond to experimental errors.
    return encodeResponse({ responseId: request.requestId, err: result.err, args: result.args });
  };
}
