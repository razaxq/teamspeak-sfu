// null means a connection-bound session with no wall-clock expiration.
// Missing or malformed values never grant access.
export function isLiveExpiry(exp, now = Date.now()) {
  return exp === null || (Number.isSafeInteger(exp) && exp * 1000 > now);
}

export function earliestExpiry(a, b) {
  return a === null ? b : b === null ? a : Math.min(a, b);
}
