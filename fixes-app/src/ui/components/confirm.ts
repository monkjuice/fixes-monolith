import { Alert } from 'react-native';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  /** Red confirm button on iOS for actions that remove or revoke something. */
  destructive?: boolean;
}

/**
 * A native two-button dialog as a promise: true only when the confirm button was pressed. Dismissing
 * it (Android back button or tapping outside) counts as cancel.
 */
export function confirm({ title, message, confirmText, cancelText = 'Cancel', destructive = false }: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelText, style: 'cancel', onPress: () => resolve(false) },
        { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
