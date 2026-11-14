import { usePreventRemove } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { toBase64 } from '../../../core/crypto/encoding';
import { LinkQrError, parseLinkQr, type LinkQr } from '../../../core/linking/qr';
import { useFixes, useLinkTransfer, useOwnIdentityKey, useSession } from '../../../hooks';
import { confirm, InlineError } from '../../components';
import { useNow } from '../../hooks/useNow';
import type { RootScreenProps } from '../../navigation/types';
import { isDeviceLinked } from '../../presentation/devices';
import { describeError } from '../../presentation/errors';
import { isOutgoingLinkRunning } from '../../presentation/linkProgress';
import { colors, spacing, typography } from '../../theme';
import { LinkProgress } from './link/LinkProgress';
import { LinkVerify, type LinkCheck } from './link/LinkVerify';
import { QrScanner } from './link/QrScanner';

type Step = { kind: 'scan' } | { kind: 'verify'; qr: string; check: LinkCheck };

const NOT_A_LINK_CODE = 'This is not a Fixes link code. On your new device, log in and scan the code shown under "Link this device".';

/**
 * "Link a new device" on a linked device (§9 steps 3–4): scan the new device's QR, check that the
 * account lists that device with exactly the scanned key, let the user confirm it, then certify it
 * and send the identity key and the history with progress. The screen stays awake meanwhile
 * (TransferKeepAwake at the root) and asks before being left while the transfer runs.
 */
export function LinkDeviceScreen({ navigation }: RootScreenProps<'LinkDevice'>) {
  const { session, messaging } = useFixes();
  const { user, device: thisDevice } = useSession();
  const ownIdentityKey = useOwnIdentityKey().publicKey;
  const { outgoing, startLink, resend, cancel, reset } = useLinkTransfer();
  const now = useNow(60_000);
  const [step, setStep] = useState<Step>({ kind: 'scan' });
  const [notice, setNotice] = useState<string | null>(null);
  // Only the newest device check may update the screen.
  const checkGeneration = useRef(0);
  const running = isOutgoingLinkRunning(outgoing.phase);

  // A link that finished or failed during an earlier visit is cleared, so the screen opens on the scanner.
  useEffect(() => {
    const phase = messaging.outgoingLink.get().phase;
    if (phase === 'done' || phase === 'failed') reset();
  }, [messaging, reset]);

  usePreventRemove(running, ({ data }) => {
    void confirm({
      title: 'Stop linking?',
      message: 'The new device keeps what it already received. You can send the rest again later.',
      confirmText: 'Stop',
      cancelText: 'Keep sending',
      destructive: true,
    }).then((stop) => {
      if (!stop) return;
      cancel();
      navigation.dispatch(data.action);
    });
  });

  const verify = useCallback(
    async (qr: string, parsed: LinkQr) => {
      const generation = ++checkGeneration.current;
      let check: LinkCheck;
      try {
        const { devices } = await session.api.listMyDevices();
        const target = devices.find((d) => d.id === parsed.deviceId);
        if (!target) {
          check = { status: 'error', message: 'The new device is not logged in to your account. Log in on it first, then scan its code again.' };
        } else if (target.public_key !== toBase64(parsed.devicePublicKey)) {
          check = { status: 'error', message: 'This code does not match the device logged in to your account. Do not link it.' };
        } else {
          // Judged under this install's AIK, never the key the server reports (§8).
          check = { status: 'ok', device: target, alreadyLinked: !!user && isDeviceLinked(target, user.id, ownIdentityKey) };
        }
      } catch (error) {
        check = { status: 'error', message: describeError(error) };
      }
      if (checkGeneration.current === generation) setStep((s) => (s.kind === 'verify' && s.qr === qr ? { ...s, check } : s));
    },
    [session, user, ownIdentityKey],
  );

  const onScanned = (text: string) => {
    if (step.kind !== 'scan' || running) return;
    let parsed: LinkQr;
    try {
      parsed = parseLinkQr(text);
    } catch (error) {
      if (!(error instanceof LinkQrError)) console.error('Unexpected error while reading a link code', error);
      setNotice(error instanceof LinkQrError && error.message.includes('newer version') ? `${error.message}.` : NOT_A_LINK_CODE);
      return;
    }
    if (parsed.deviceId === thisDevice?.id) {
      setNotice('This is the code of this device. Scan the code shown on your new device.');
      return;
    }
    setNotice(null);
    const qr = text.trim();
    setStep({ kind: 'verify', qr, check: { status: 'loading' } });
    void verify(qr, parsed);
  };

  const link = (qr: string) => {
    setNotice(null);
    setStep({ kind: 'scan' });
    // The engine refuses synchronously when it is not running; the promise turns that into a rejection.
    Promise.resolve()
      .then(() => startLink(qr))
      .catch((error: unknown) => setNotice(describeError(error)));
  };

  const scanAgain = () => {
    reset();
    setNotice(null);
    setStep({ kind: 'scan' });
  };

  let content;
  if (outgoing.phase !== 'idle') {
    content = (
      <LinkProgress
        state={outgoing}
        onCancel={cancel}
        onResend={() => {
          Promise.resolve()
            .then(() => resend())
            .catch((error: unknown) => setNotice(describeError(error)));
        }}
        onScanAgain={scanAgain}
        onDone={() => {
          reset();
          navigation.goBack();
        }}
      />
    );
  } else if (step.kind === 'verify') {
    content = <LinkVerify check={step.check} now={now} onConfirm={() => link(step.qr)} onCancel={scanAgain} />;
  } else {
    content = (
      <>
        <Text style={styles.step}>{'1. On your new device, log in to Fixes. It shows a code under "Link this device".'}</Text>
        <Text style={styles.step}>2. Point this camera at that code.</Text>
        <QrScanner onScanned={onScanned} paused={step.kind !== 'scan'} />
      </>
    );
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      {content}
      <InlineError message={notice} testID="link-notice" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.lg, gap: spacing.md },
  step: { ...typography.body },
});
