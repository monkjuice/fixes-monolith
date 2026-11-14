import { isUuidV4 } from '../crypto/random';
import { isIncomingStatus, isOutgoingStatus, type IncomingStatus, type OutgoingStatus } from '../db/types';
import {
  asObject,
  base64KeyField,
  nullableTimestampField,
  PayloadError,
  textField,
  timestampField,
  uuidField,
  type Obj,
} from './fields';
import { MAX_MESSAGE_BODY_CHARS } from './message';

/**
 * Records shared by the `history` inner payload (protocol §7.3) and the backup body (§10):
 * `{"conversations":[Conv], "messages":[Msg], "contact_identities":[Ident]}`. System messages are
 * never exported.
 */

export interface ConvRecord {
  peer_user_id: string;
  peer_username: string;
  peer_avatar_url: string | null;
}

export type MsgRecord =
  | {
      id: string;
      peer_user_id: string;
      direction: 'out';
      sender_user_id: string;
      body: string;
      sent_at: number;
      server_ts: number | null;
      status: OutgoingStatus;
    }
  | {
      id: string;
      peer_user_id: string;
      direction: 'in';
      sender_user_id: string;
      body: string;
      sent_at: number;
      server_ts: number | null;
      status: IncomingStatus;
    };

export interface IdentRecord {
  user_id: string;
  /** Base64 Ed25519 public key. */
  identity_key: string;
  first_seen_at: number;
  verified: boolean;
}

export interface SnapshotBody {
  conversations: ConvRecord[];
  messages: MsgRecord[];
  contact_identities: IdentRecord[];
}

/** A validated snapshot: invalid rows are skipped and counted (§10), never fatal. */
export interface ParsedSnapshot extends SnapshotBody {
  skipped: number;
}

const MAX_USERNAME_CHARS = 64;
const MAX_URL_LENGTH = 2048;
const HTTP_URL = /^https?:\/\/[^\s]+$/;

function parseConv(value: unknown, me: string): ConvRecord {
  const o = asObject(value, 'conversation');
  const peer = uuidField(o, 'peer_user_id');
  if (peer === me) throw new PayloadError('Conversation with oneself');
  const avatar = o.peer_avatar_url;
  if (avatar !== null && (typeof avatar !== 'string' || avatar.length > MAX_URL_LENGTH || !HTTP_URL.test(avatar))) {
    throw new PayloadError('peer_avatar_url must be an http(s) URL or null');
  }
  return {
    peer_user_id: peer,
    peer_username: textField(o, 'peer_username', 1, MAX_USERNAME_CHARS),
    peer_avatar_url: avatar,
  };
}

/** §10 consistency: direction, status valid for it, `sender_user_id` = me (out) or the peer (in). */
function parseMsg(value: unknown, me: string): MsgRecord {
  const o = asObject(value, 'message');
  const peer = uuidField(o, 'peer_user_id');
  if (peer === me) throw new PayloadError('Message with oneself');
  const sender = uuidField(o, 'sender_user_id');
  const common = {
    id: uuidField(o, 'id'),
    peer_user_id: peer,
    sender_user_id: sender,
    body: textField(o, 'body', 1, MAX_MESSAGE_BODY_CHARS),
    sent_at: timestampField(o, 'sent_at'),
    server_ts: nullableTimestampField(o, 'server_ts'),
  };
  if (o.direction === 'out') {
    if (sender !== me) throw new PayloadError('Outgoing message not sent by this user');
    if (!isOutgoingStatus(o.status)) throw new PayloadError('Invalid outgoing status');
    return { ...common, direction: 'out', status: o.status };
  }
  if (o.direction === 'in') {
    if (sender !== peer) throw new PayloadError('Incoming message not sent by the peer');
    if (!isIncomingStatus(o.status)) throw new PayloadError('Invalid incoming status');
    return { ...common, direction: 'in', status: o.status };
  }
  throw new PayloadError('direction must be "in" or "out"');
}

function parseIdent(value: unknown, me: string): IdentRecord {
  const o = asObject(value, 'contact identity');
  const userId = uuidField(o, 'user_id');
  // The own AIK is never pinned in contact_identities (§8).
  if (userId === me) throw new PayloadError('Own identity in contact identities');
  const verified = o.verified;
  if (verified !== true && verified !== false && verified !== 0 && verified !== 1) {
    throw new PayloadError('verified must be a boolean');
  }
  return {
    user_id: userId,
    identity_key: base64KeyField(o, 'identity_key', 32),
    first_seen_at: timestampField(o, 'first_seen_at'),
    verified: verified === true || verified === 1,
  };
}

function parseList<T>(o: Obj, key: string, parse: (v: unknown) => T, counter: { skipped: number }): T[] {
  const value = o[key];
  if (!Array.isArray(value)) throw new PayloadError(`${key} must be an array`);
  const out: T[] = [];
  for (const item of value) {
    try {
      out.push(parse(item));
    } catch (error) {
      if (!(error instanceof PayloadError)) throw error;
      counter.skipped++;
    }
  }
  return out;
}

/**
 * Validates a history chunk or backup body for the account `me`. The top-level shape must be right
 * (otherwise PayloadError); individual invalid rows are skipped and counted.
 */
export function parseSnapshotBody(value: unknown, me: string): ParsedSnapshot {
  if (!isUuidV4(me)) throw new RangeError('Invalid user id');
  const o = asObject(value, 'snapshot');
  const counter = { skipped: 0 };
  const conversations = parseList(o, 'conversations', (v) => parseConv(v, me), counter);
  const messages = parseList(o, 'messages', (v) => parseMsg(v, me), counter);
  const contactIdentities = parseList(o, 'contact_identities', (v) => parseIdent(v, me), counter);
  return { conversations, messages, contact_identities: contactIdentities, skipped: counter.skipped };
}
