export type CryptoErrorCode =
  | 'invalid_encoding'
  | 'invalid_key'
  | 'invalid_shared_secret'
  | 'decrypt_failed'
  | 'invalid_payload'
  | 'payload_too_large'
  | 'random_unavailable'
  | 'invalid_recovery_key'
  | 'invalid_backup'
  | 'unsupported_backup'
  | 'backup_user_mismatch'
  | 'invalid_transfer';

/**
 * Thrown by src/core/crypto. Messages never contain key material or plaintext, so they are safe
 * to log and to show to developers.
 */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
    this.code = code;
  }
}
