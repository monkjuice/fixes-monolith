import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Topics } from '../../../core/db/changes';
import type { LocalStore } from '../../../core/db/localStore';
import type { MessageRow } from '../../../core/db/types';
import { PLACEHOLDER_PEER_NAME } from '../../../core/messaging/conversationSummary';
import { useContactIdentity, useFixes, useLocalStore, useMessages, useStoreQuery } from '../../../hooks';
import { Composer, EmptyState, IconButton, KeyboardAvoidingScreen, MessageBubble } from '../../components';
import { useAppActive } from '../../hooks/useAppActive';
import type { RootScreenProps } from '../../navigation/types';
import { describeError, reportBackgroundError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';
import { SafetyCodeBanner } from './SafetyCodeBanner';

const CONVERSATION_TOPICS = [Topics.conversations];
const keyExtractor = (message: MessageRow) => message.id;

/**
 * Legacy ConversationPage (§14): title = peer username, bubbles right (mine) / left, entry + Send.
 * The list is inverted so it opens on, and stays at, the newest message. Incoming messages count as
 * read only while this screen is focused and the app is in the foreground (§7.2 read receipts).
 */
export function ConversationScreen({ navigation, route }: RootScreenProps<'Conversation'>) {
  const { peerUserId, peerUsername, profile } = route.params;
  const { messaging } = useFixes();
  const store = useLocalStore();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const appActive = useAppActive();
  const list = useRef<FlatList<MessageRow>>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  const loadConversation = useCallback((s: LocalStore) => s.conversations.get(peerUserId), [peerUserId]);
  const conversation = useStoreQuery(store, CONVERSATION_TOPICS, loadConversation, null);
  const page = useMessages(peerUserId);
  const identity = useContactIdentity(peerUserId);
  const pending = !!identity.data?.pending_identity_key;
  const title = conversation.data?.peer_username ?? peerUsername ?? profile?.username ?? PLACEHOLDER_PEER_NAME;

  useLayoutEffect(() => {
    navigation.setOptions({
      title,
      headerRight: () => (
        <IconButton
          icon="person-circle-outline"
          accessibilityLabel={`Profile of ${title}`}
          color={colors.white}
          size={28}
          onPress={() => navigation.navigate('UserProfile', { userId: peerUserId, username: title })}
        />
      ),
    });
  }, [navigation, title, peerUserId]);

  // Mark as read on focus and whenever a new unread message arrives while the user is looking.
  const newestUnreadId = useMemo(
    () => page.messages.find((m) => m.direction === 'in' && m.status === 'received')?.id ?? null,
    [page.messages],
  );
  const unreadCount = conversation.data?.unread_count ?? 0;
  useEffect(() => {
    if (!isFocused || !appActive || (newestUnreadId === null && unreadCount === 0)) return;
    messaging
      .markConversationRead(peerUserId)
      .catch((error: unknown) => reportBackgroundError('Marking the conversation as read', error));
  }, [isFocused, appActive, newestUnreadId, unreadCount, messaging, peerUserId]);

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      setNotice(null);
      try {
        await messaging.sendMessage(peerUserId, body, { profile });
      } catch (error) {
        setNotice(describeError(error));
        return false;
      }
      list.current?.scrollToOffset({ offset: 0, animated: true });
      return true;
    },
    [messaging, peerUserId, profile],
  );

  const retry = useCallback(
    (messageId: string) => {
      setNotice(null);
      messaging.retryMessage(messageId).catch((error: unknown) => setNotice(describeError(error)));
    },
    [messaging],
  );

  const accept = () => {
    setAccepting(true);
    setNotice(null);
    messaging
      .acceptIdentityChange(peerUserId)
      .catch((error: unknown) => setNotice(describeError(error)))
      .finally(() => setAccepting(false));
  };

  const renderItem = useCallback(({ item }: { item: MessageRow }) => <MessageBubble message={item} onRetry={retry} />, [retry]);

  let body;
  if (page.error) {
    body = (
      <View style={styles.center}>
        <Text style={styles.error} accessibilityRole="alert">
          Messages could not be loaded.
        </Text>
      </View>
    );
  } else if (!page.loading && page.messages.length === 0) {
    // Outside the inverted list: an inverted FlatList would also flip its empty component.
    body = (
      <View style={styles.center}>
        <EmptyState icon="chatbubble-outline" title="No messages yet" message={`Say hello to ${title}.`} />
      </View>
    );
  } else {
    body = (
      <FlatList
        ref={list}
        inverted
        data={page.messages}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onEndReached={page.loadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={page.loadingMore ? <ActivityIndicator style={styles.more} color={colors.black} /> : null}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        testID="message-list"
      />
    );
  }

  return (
    <KeyboardAvoidingScreen>
      <View style={[styles.page, { paddingBottom: insets.bottom }]}>
        {pending ? (
          <SafetyCodeBanner
            username={title}
            accepting={accepting}
            onAccept={accept}
            onViewCode={() => navigation.navigate('Security', { userId: peerUserId, username: title })}
          />
        ) : null}
        {body}
        {notice ? (
          <Text style={styles.notice} accessibilityRole="alert" testID="conversation-notice">
            {notice}
          </Text>
        ) : null}
        <Composer onSend={send} disabled={pending} disabledReason="Accept the new safety code to send messages" />
      </View>
    </KeyboardAvoidingScreen>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  list: { paddingVertical: spacing.sm },
  more: { marginVertical: spacing.md },
  center: { flex: 1, justifyContent: 'center' },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
  notice: { ...typography.body, color: colors.danger, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
});
