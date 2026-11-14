import { DefaultTheme, type Theme } from '@react-navigation/native';

import { colors } from '../theme';

/** White pages and black bars (legacy App.xaml); headers and tabs also set their colours explicitly. */
export const navigationTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.black,
    background: colors.white,
    card: colors.black,
    text: colors.white,
    border: colors.black,
  },
};
