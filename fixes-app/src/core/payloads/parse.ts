import { CryptoError } from '../crypto/errors';
import { parseTransferPayload, type TransferPayload } from '../crypto/transfer';
import { asObject, PayloadError } from './fields';
import { parseMessagePayload, type MessagePayload } from './message';
import { parseReceiptWirePayload, type ReceiptPayload } from './receipt';

export type ParsedPayload =
  | { kind: 'message'; payload: MessagePayload }
  | { kind: 'receipt'; payload: ReceiptPayload }
  | { kind: 'link' | 'history'; payload: TransferPayload }
  /** Another version or kind: acked and ignored (§7). */
  | { kind: 'unknown' };

/** The `kind` a decrypted value claims to be, before validation (used to pick the failure reaction). */
export function declaredKind(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : null;
}

/**
 * Dispatches a decrypted payload on `v`/`kind` and validates it strictly. Throws PayloadError for a
 * known v1 kind with any invalid field; unknown versions and kinds come back as `unknown`.
 */
export function parsePayload(value: unknown): ParsedPayload {
  const o = asObject(value, 'payload');
  if (o.v !== 1) return { kind: 'unknown' };
  switch (o.kind) {
    case 'message':
      return { kind: 'message', payload: parseMessagePayload(o) };
    case 'receipt':
      return { kind: 'receipt', payload: parseReceiptWirePayload(o) };
    case 'link':
    case 'history':
      try {
        const payload = parseTransferPayload(o);
        return { kind: payload.kind, payload };
      } catch (error) {
        if (error instanceof CryptoError) throw new PayloadError(`Invalid ${o.kind} payload: ${error.message}`);
        throw error;
      }
    default:
      return { kind: 'unknown' };
  }
}
