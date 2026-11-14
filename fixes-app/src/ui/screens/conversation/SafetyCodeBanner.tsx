import { Banner } from '../../components';

export interface SafetyCodeBannerProps {
  username: string;
  accepting: boolean;
  onAccept(): void;
  onViewCode(): void;
}

/**
 * §8 AIK change: sending stays blocked until the user accepts the contact's new identity key here.
 * Messages from devices certified by the new key are already shown below the system message.
 */
export function SafetyCodeBanner({ username, accepting, onAccept, onViewCode }: SafetyCodeBannerProps) {
  return (
    <Banner
      tone="warning"
      icon="shield-outline"
      text={`${username}'s safety code changed. This happens when they reset their security identity, for example on a new phone. Compare safety codes to be sure, then tap Accept to keep messaging.`}
      actions={[
        { title: 'View safety code', onPress: onViewCode },
        { title: accepting ? 'Accepting..' : 'Accept', onPress: onAccept, busy: accepting },
      ]}
      testID="safety-code-banner"
    />
  );
}
