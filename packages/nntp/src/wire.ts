/** Formatting helpers for values that go onto, or come off, the wire. */

/**
 * Wrap a Message-ID in the angle brackets the protocol requires.
 *
 * NZBs store Message-IDs bare and some posters leave the brackets on, so both
 * forms are normalized to exactly one pair. Sending a bare ID is a `430` on
 * every article.
 */
export function wrapMessageId(messageId: string): string {
  const bare =
    messageId.startsWith('<') && messageId.endsWith('>') ? messageId.slice(1, -1) : messageId;
  return `<${bare}>`;
}

/**
 * Strip anything that could carry a secret before it reaches an error message
 * or a log line, so `AUTHINFO PASS hunter2` becomes `AUTHINFO PASS`.
 */
export function redact(text: string): string {
  return /^AUTHINFO\s+PASS\b/iu.test(text) ? 'AUTHINFO PASS' : text;
}
