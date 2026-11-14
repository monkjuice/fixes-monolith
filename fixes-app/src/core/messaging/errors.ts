export type MessagingErrorCode =
  /** No signed-in session (or, for sending, the device is not linked yet). */
  | 'not_ready'
  | 'invalid_peer'
  | 'invalid_body'
  /** The contact's safety code changed; sending waits for Accept (§8). */
  | 'identity_pending'
  | 'not_found';

const MESSAGES: Record<MessagingErrorCode, string> = {
  not_ready: 'Messaging is not available right now.',
  invalid_peer: 'Invalid conversation.',
  invalid_body: 'Messages have 1 to 4000 characters.',
  identity_pending: "This contact's safety code changed. Accept the new code to send messages.",
  not_found: 'Message not found.',
};

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;

  constructor(code: MessagingErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MessagingError';
    this.code = code;
  }
}

/**
 * Thrown by the logout hook when the outbox still holds items after the flush (§13 "warn if items
 * remain"). `MessagingEngine.logout({ force: true })` logs out anyway.
 */
export class OutboxNotEmptyError extends Error {
  constructor(readonly remaining: number) {
    super(`${remaining} message(s) or receipt(s) could not be sent yet`);
    this.name = 'OutboxNotEmptyError';
  }
}

/**
 * Thrown by the logout hook when messaging is not running (the session is still loading, or failed to
 * load), so this device's mailbox cannot be drained first (§13). The server deletes what still waits
 * for the device when it is revoked (§5.4); `MessagingEngine.logout({ force: true })` logs out anyway.
 */
export class MailboxNotDrainedError extends Error {
  constructor() {
    super('Messages waiting for this device on the server could not be received first');
    this.name = 'MailboxNotDrainedError';
  }
}
