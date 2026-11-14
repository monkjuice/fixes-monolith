import { isUuidV4 } from '../crypto/random';
import {
  asObject,
  codePointLength,
  isTimestamp,
  isWellFormedText,
  PayloadError,
  textField,
  timestampField,
  uuidField,
} from './fields';

/** `message` payload (protocol §7.1). */

export const MAX_MESSAGE_BODY_CHARS = 4000;

export interface MessagePayload {
  v: 1;
  kind: 'message';
  id: string;
  from: string;
  to: string;
  body: string;
  /** Sender clock, display only. */
  sent_at: number;
}

/** True when `body` may be sent: 1–4000 characters (code points) of well-formed text. */
export function isValidMessageBody(body: unknown): body is string {
  if (typeof body !== 'string' || !isWellFormedText(body)) return false;
  const length = codePointLength(body);
  return length >= 1 && length <= MAX_MESSAGE_BODY_CHARS;
}

export function buildMessagePayload(params: {
  id: string;
  from: string;
  to: string;
  body: string;
  sentAt: number;
}): MessagePayload {
  if (!isUuidV4(params.id) || !isUuidV4(params.from) || !isUuidV4(params.to)) {
    throw new PayloadError('Message ids must be UUIDv4');
  }
  if (params.from === params.to) throw new PayloadError('Self-chat is not allowed');
  if (!isValidMessageBody(params.body)) throw new PayloadError('Message body must have 1 to 4000 characters');
  if (!isTimestamp(params.sentAt)) throw new PayloadError('sent_at must be a timestamp');
  return { v: 1, kind: 'message', id: params.id, from: params.from, to: params.to, body: params.body, sent_at: params.sentAt };
}

/** Validates every field of a decrypted `message` payload (the caller checked `v` and `kind`). */
export function parseMessagePayload(value: unknown): MessagePayload {
  const o = asObject(value, 'message');
  if (o.v !== 1 || o.kind !== 'message') throw new PayloadError('Not a v1 message payload');
  const from = uuidField(o, 'from');
  const to = uuidField(o, 'to');
  if (from === to) throw new PayloadError('Self-chat is not allowed');
  return {
    v: 1,
    kind: 'message',
    id: uuidField(o, 'id'),
    from,
    to,
    body: textField(o, 'body', 1, MAX_MESSAGE_BODY_CHARS),
    sent_at: timestampField(o, 'sent_at'),
  };
}

export interface EnvelopeOrigin {
  /** From the server's envelope metadata (authenticated by the envelope AAD), never from the payload. */
  senderUserId: string;
  senderDeviceId: string;
}

export interface LocalIdentity {
  userId: string;
  deviceId: string;
}

export type MessageRoute =
  | { kind: 'incoming'; peer: string }
  | { kind: 'sync'; peer: string }
  | { kind: 'drop'; reason: string };

/**
 * The receipt rules of §7.1: a message from another user must name that user as `from` and me as
 * `to`; a sync copy must come from another device of mine. Anything else is dropped.
 */
export function routeMessage(payload: MessagePayload, origin: EnvelopeOrigin, me: LocalIdentity): MessageRoute {
  if (origin.senderUserId !== me.userId) {
    if (payload.from === origin.senderUserId && payload.to === me.userId && payload.from !== me.userId) {
      return { kind: 'incoming', peer: payload.from };
    }
    return { kind: 'drop', reason: 'message from/to do not match the envelope sender and recipient' };
  }
  if (payload.from === me.userId && payload.to !== me.userId && origin.senderDeviceId !== me.deviceId) {
    return { kind: 'sync', peer: payload.to };
  }
  return { kind: 'drop', reason: 'invalid sync copy' };
}
