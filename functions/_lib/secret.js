// SESSION_SECRET strength check. Pure, no I/O.

/** Minimum accepted length of SESSION_SECRET, in characters. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * True when the secret is a string of at least MIN_SESSION_SECRET_LENGTH characters.
 * Callers answer 500 `server_misconfigured` when this is false.
 * @param {unknown} secret
 * @returns {boolean}
 */
export function isSessionSecretUsable(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SESSION_SECRET_LENGTH;
}
