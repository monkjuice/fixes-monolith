import { ApiError, isTransientError } from '../api/errors';
import type { MyDevice, OutgoingEnvelope, PostEnvelopesResponse } from '../api/types';
import { toBase64 } from '../crypto/encoding';
import { signDeviceCertificate, verifyDeviceCertificate, type IdentityKeyPair } from '../crypto/identity';
import { uuidv4 } from '../crypto/random';
import { sealTransfer, type TransferPayload } from '../crypto/transfer';
import type { LocalStore } from '../db/localStore';
import type { Logger } from '../logger';
import type { EnvelopeCodec } from '../messaging/envelopeCodec';
import { buildLinkInner } from '../payloads/link';
import { chunkSnapshot, readSnapshot } from '../snapshot/export';
import type { DeviceDirectory } from '../trust/deviceDirectory';
import { StateCell } from '../utils/stateCell';
import { LinkQrError, parseLinkQr, type LinkQr } from './qr';

/**
 * The linked device's side of linking (protocol §9 steps 3–4): checks the scanned QR against
 * `GET /v1/devices`, certifies the new device, sends the `link` envelope, drains its own mailbox,
 * snapshots the history in one read transaction and sends it in `history` chunks with progress.
 * Keeping the screen awake is the UI's job (it watches `phase`).
 */

export type OutgoingLinkPhase =
  | 'idle'
  | 'checking'
  | 'certifying'
  | 'sendingLink'
  | 'syncing'
  | 'preparing'
  | 'sendingHistory'
  | 'done'
  | 'failed';

export type OutgoingLinkErrorCode =
  | 'invalid_qr'
  | 'own_device'
  | 'not_linked'
  | 'device_not_found'
  | 'key_mismatch'
  | 'unauthorized'
  | 'device_unavailable'
  | 'mailbox_full'
  | 'rate_limited'
  | 'interrupted'
  | 'cancelled'
  | 'failed';

export interface OutgoingLinkState {
  phase: OutgoingLinkPhase;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
  sentChunks: number;
  totalChunks: number;
  attempt: number;
  error: { code: OutgoingLinkErrorCode; message: string } | null;
  /** §9 step 4: after an interruption the user may resend (a new attempt with the same QR). */
  canResend: boolean;
}

export const IDLE_OUTGOING_LINK: OutgoingLinkState = {
  phase: 'idle',
  targetDeviceId: null,
  targetDeviceName: null,
  sentChunks: 0,
  totalChunks: 0,
  attempt: 0,
  error: null,
  canResend: false,
};

export interface LinkApi {
  listMyDevices(): Promise<{ devices: MyDevice[] }>;
  putDeviceCertificate(deviceId: string, certificate: string): Promise<MyDevice>;
  postEnvelopes(envelopes: OutgoingEnvelope[], completeForUserIds?: string[]): Promise<PostEnvelopesResponse>;
}

export interface OutgoingLinkOptions {
  api: LinkApi;
  store: LocalStore;
  directory: DeviceDirectory;
  codec: EnvelopeCodec;
  self: { userId: string; deviceId: string };
  logger: Logger;
  getIdentity(): Promise<IdentityKeyPair | null>;
  /** Drains this device's mailbox so the snapshot includes everything received so far. */
  drainMailbox(): Promise<void>;
  /** History envelopes per POST (each is up to ~64 KiB; the request limit is 9 MiB). */
  batchSize: number;
}

class LinkFailure extends Error {
  constructor(
    readonly code: OutgoingLinkErrorCode,
    message: string,
    readonly resendable: boolean,
  ) {
    super(message);
    this.name = 'LinkFailure';
  }
}

const MESSAGES: Record<OutgoingLinkErrorCode, string> = {
  invalid_qr: 'This is not a Fixes link code.',
  own_device: 'This code belongs to this device.',
  not_linked: 'This device cannot link others because it does not hold the account identity key.',
  device_not_found: 'The new device is not signed in to your account. Log in on it first.',
  key_mismatch: 'The code does not match the device signed in to your account. Do not link it.',
  unauthorized: 'This device is no longer signed in.',
  device_unavailable: 'The new device is no longer available (signed out or revoked).',
  mailbox_full: 'The new device has too many pending messages. Try again later.',
  rate_limited: 'Too many requests. Try again in a minute.',
  interrupted: 'The transfer was interrupted.',
  cancelled: 'The transfer was cancelled.',
  failed: 'Linking failed.',
};

export class OutgoingLink {
  readonly state = new StateCell<OutgoingLinkState>(IDLE_OUTGOING_LINK);
  private qr: LinkQr | null = null;
  private running = false;
  private cancelled = false;
  private disposed = false;

  constructor(private readonly options: OutgoingLinkOptions) {}

  /** Starts linking the device shown in `qrText`. Never throws: the outcome is in `state`. */
  async start(qrText: string): Promise<void> {
    if (this.running) return;
    let qr: LinkQr;
    try {
      qr = parseLinkQr(qrText);
    } catch (error) {
      if (!(error instanceof LinkQrError)) throw error;
      this.state.set({ ...IDLE_OUTGOING_LINK, phase: 'failed', error: { code: 'invalid_qr', message: error.message } });
      return;
    }
    this.qr = qr;
    this.state.set({ ...IDLE_OUTGOING_LINK, targetDeviceId: qr.deviceId });
    await this.run();
  }

  /** A new attempt with the same QR (only after an interruption). */
  async resend(): Promise<void> {
    if (this.running || !this.qr || !this.state.get().canResend) return;
    await this.run();
  }

  /** Stops after the current request; the new device keeps what it already imported. */
  cancel(): void {
    if (this.running) this.cancelled = true;
  }

  reset(): void {
    if (this.running) return;
    this.qr = null;
    this.state.set(IDLE_OUTGOING_LINK);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelled = true;
  }

  private async run(): Promise<void> {
    const qr = this.qr!;
    this.running = true;
    this.cancelled = false;
    const attempt = this.state.get().attempt + 1;
    this.state.update({ phase: 'checking', attempt, error: null, canResend: false, sentChunks: 0, totalChunks: 0 });
    try {
      await this.attempt(qr);
      this.state.update({ phase: 'done' });
    } catch (error) {
      const failure = this.classify(error);
      if (failure.code === 'failed') this.options.logger.error('Linking a device failed', error);
      this.state.update({
        phase: 'failed',
        error: { code: failure.code, message: failure.message },
        canResend: failure.resendable,
      });
    } finally {
      this.running = false;
    }
  }

  private async attempt(qr: LinkQr): Promise<void> {
    const { api, self, directory, store } = this.options;
    const attemptId = uuidv4();
    const identity = await this.options.getIdentity();
    if (!identity) throw this.failure('not_linked', false);
    if (qr.deviceId === self.deviceId) throw this.failure('own_device', false);

    // §9 step 3: the device must be listed with exactly the QR's public key.
    const { devices } = await api.listMyDevices();
    const target = devices.find((d) => d.id === qr.deviceId);
    if (!target) throw this.failure('device_not_found', false);
    if (target.public_key !== toBase64(qr.devicePublicKey)) throw this.failure('key_mismatch', false);
    this.state.update({ targetDeviceName: target.name });
    const alreadyCertified = verifyDeviceCertificate({
      identityPublicKey: identity.publicKey,
      userId: self.userId,
      deviceId: target.id,
      devicePublicKey: qr.devicePublicKey,
      certificate: target.certificate,
    });
    if (!alreadyCertified) {
      this.state.update({ phase: 'certifying' });
      await api.putDeviceCertificate(target.id, signDeviceCertificate(identity, self.userId, target.id, qr.devicePublicKey));
    }
    // The new device is now one of my eligible devices (sync copies go to it from now on).
    directory.invalidate(self.userId);
    this.checkCancelled();

    this.state.update({ phase: 'sendingLink' });
    const link = sealTransfer(
      { kind: 'link', transferId: qr.transferId, attemptId, seq: 0, total: 1 },
      buildLinkInner(identity),
      qr.transferKey,
    );
    await this.post(qr, [link]);
    this.checkCancelled();

    this.state.update({ phase: 'syncing' });
    await this.options.drainMailbox();
    this.checkCancelled();

    this.state.update({ phase: 'preparing' });
    const chunks = chunkSnapshot(await readSnapshot(store));
    const total = chunks.length;
    const sealed = chunks.map((inner, seq) =>
      sealTransfer({ kind: 'history', transferId: qr.transferId, attemptId, seq, total }, inner, qr.transferKey),
    );
    this.state.update({ phase: 'sendingHistory', sentChunks: 0, totalChunks: total });
    for (let i = 0; i < sealed.length; i += this.options.batchSize) {
      this.checkCancelled();
      const batch = sealed.slice(i, i + this.options.batchSize);
      await this.post(qr, batch);
      this.state.update({ sentChunks: i + batch.length });
    }
  }

  private async post(qr: LinkQr, payloads: TransferPayload[]): Promise<void> {
    const target = { deviceId: qr.deviceId, publicKey: qr.devicePublicKey };
    const envelopes = payloads.flatMap((payload) => this.options.codec.seal(payload, [target]));
    const response = await this.options.api.postEnvelopes(envelopes);
    if (response.dropped_device_ids.length > 0 || response.ids.some((id) => id === null)) {
      throw this.failure('mailbox_full', true);
    }
  }

  private checkCancelled(): void {
    if (this.cancelled) throw this.failure('cancelled', !this.disposed);
  }

  private failure(code: OutgoingLinkErrorCode, resendable: boolean): LinkFailure {
    return new LinkFailure(code, MESSAGES[code], resendable);
  }

  /** §9 step 4: 401/409 abort with a visible error; interruptions offer Resend. */
  private classify(error: unknown): LinkFailure {
    if (error instanceof LinkFailure) return error;
    if (error instanceof ApiError) {
      if (error.status === 401) return this.failure('unauthorized', false);
      if (error.status === 409) return this.failure('device_unavailable', false);
      if (error.status === 404) return this.failure('device_not_found', false);
      if (error.code === 'rate_limited') return this.failure('rate_limited', true);
    }
    if (isTransientError(error)) return this.failure('interrupted', true);
    return this.failure('failed', true);
  }
}
