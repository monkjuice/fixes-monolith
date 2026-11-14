import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { codePointLength } from '../../core/payloads/fields';
import { MAX_MESSAGE_BODY_CHARS } from '../../core/payloads/message';
import { colors, MIN_TOUCH_SIZE, spacing } from '../theme';

export interface ComposerProps {
  /** Resolves true when the message was stored (the field is cleared), false to keep the text. */
  onSend(body: string): Promise<boolean>;
  disabled?: boolean;
  /** Shown as the placeholder while sending is not possible (e.g. safety code awaiting Accept). */
  disabledReason?: string;
}

/** The counter appears this close to the limit. */
const COUNTER_FROM = MAX_MESSAGE_BODY_CHARS - 200;

/**
 * Legacy entry + Send (the camera button is gone, §14). The 4000-character limit (§7.1) counts code
 * points, which TextInput's maxLength (UTF-16 units) cannot express: it only caps input at twice the
 * limit, and Send stays disabled while the text is over it.
 */
export function Composer({ onSend, disabled = false, disabledReason }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const body = text.trim();
  const length = codePointLength(body);
  const tooLong = length > MAX_MESSAGE_BODY_CHARS;
  const canSend = !disabled && !sending && length > 0 && !tooLong;

  const send = async () => {
    if (!canSend) return;
    // The field stays editable while the message is stored: only what was sent is removed, so text
    // typed meanwhile (the next message) survives.
    const sentText = text;
    setSending(true);
    try {
      if (await onSend(body)) {
        setText((current) =>
          current === sentText ? '' : current.startsWith(sentText) ? current.slice(sentText.length).trimStart() : current,
        );
      }
    } catch (error) {
      // onSend reports its own errors; reaching this is a bug, and the text stays for another try.
      console.error('Sending from the composer failed', error);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.field}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={disabled && disabledReason ? disabledReason : 'Message..'}
          placeholderTextColor={colors.placeholder}
          accessibilityLabel="Message"
          accessibilityHint={disabled && disabledReason ? disabledReason : undefined}
          editable={!disabled}
          multiline
          maxLength={MAX_MESSAGE_BODY_CHARS * 2}
          style={styles.input}
          testID="composer-input"
        />
        {length >= COUNTER_FROM ? (
          <Text style={[styles.counter, tooLong && styles.counterOver]} testID="composer-counter" accessibilityLiveRegion="polite">
            {`${length}/${MAX_MESSAGE_BODY_CHARS}`}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        accessibilityState={{ disabled: !canSend, busy: sending }}
        disabled={!canSend}
        onPress={() => void send()}
        style={({ pressed }) => [styles.send, pressed && styles.pressed]}
        testID="composer-send"
      >
        <Text style={[styles.sendText, !canSend && styles.sendDisabled]}>Send</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.white,
    gap: spacing.xs,
  },
  field: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_SIZE,
  },
  input: { fontSize: 15, color: colors.text, maxHeight: 120, paddingVertical: spacing.sm },
  counter: { alignSelf: 'flex-end', fontSize: 11, color: colors.textMuted, paddingBottom: spacing.xs },
  counterOver: { color: colors.danger, fontWeight: '700' },
  send: { minWidth: 56, minHeight: MIN_TOUCH_SIZE, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  sendText: { fontSize: 16, fontWeight: '700', color: colors.black },
  sendDisabled: { color: colors.border },
});
