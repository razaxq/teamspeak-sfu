import { randomUUID } from 'node:crypto';
import { encodeRequest, WireError } from './wire.js';

// Private server-to-client request correlation. This grants no viewing rights;
// the caller must select an authenticated publisher and authorize each viewer.
export function createRequestChannel({ send, timeoutMs = 5000, maxPending = 8 }) {
  if (typeof send !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1
      || !Number.isInteger(maxPending) || maxPending < 1) throw new TypeError('Invalid request channel');
  const pending = new Map(); let closed = false;
  return {
    request(cmd, args) {
      if (closed) return Promise.reject(new WireError('CHANNEL_CLOSED'));
      if (pending.size >= maxPending) return Promise.reject(new WireError('QUEUE_LIMIT'));
      const requestId = 'server:' + randomUUID();
      let frame;
      try { frame = encodeRequest({ cmd, requestId, args }); }
      catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId); reject(new WireError('CLIENT_RESPONSE_TIMEOUT'));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try { send(frame); }
        catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
      });
    },
    accept(frame) {
      if (closed || frame.type !== 'response') return false;
      const item = pending.get(frame.responseId);
      if (!item) return false;
      pending.delete(frame.responseId); clearTimeout(item.timer); item.resolve(frame);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer); item.reject(new WireError('CHANNEL_CLOSED'));
      }
      pending.clear();
    },
  };
}
