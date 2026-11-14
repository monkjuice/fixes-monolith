import type { TextStyle } from 'react-native';

/**
 * Legacy look (xamFixes App.xaml / MainPage.xaml): white pages, black navigation and tab bars with
 * white text, black floating action button. Named colours are the Xamarin.Forms (CSS) values the
 * legacy app used, so the §14 status colours match it exactly.
 */
export const colors = {
  black: '#000000',
  white: '#FFFFFF',
  text: '#000000',
  /** Xamarin `Gray`: secondary text, incoming arrows. */
  textMuted: '#808080',
  /** Xamarin `DimGray`: entry placeholders on the legacy login page. */
  placeholder: '#696969',
  /** Xamarin `LightGray`: separators, disabled buttons. */
  border: '#D3D3D3',
  surface: '#F2F2F2',
  /** Tab bar icons: white selected, 40 % white unselected (legacy `#66FFFFFF`). */
  tabActive: '#FFFFFF',
  tabInactive: 'rgba(255, 255, 255, 0.4)',
  danger: '#C62828',
  warningBackground: '#FFF3E0',
  warningBorder: '#FFA500',
} as const;

/**
 * §14 arrow/tick colours: incoming Gray; outgoing read Orange, delivered Blue, sent LightGray,
 * pending Red, failed Red (+ retry icon).
 */
export const statusColors = {
  incoming: '#808080',
  read: '#FFA500',
  delivered: '#0000FF',
  sent: '#D3D3D3',
  pending: '#FF0000',
  failed: '#FF0000',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Minimum touch target (Apple HIG 44 pt; Android asks for 48 dp, which hitSlop tops up). */
export const MIN_TOUCH_SIZE = 44;

export const typography = {
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  heading: { fontSize: 17, fontWeight: '700', color: colors.text },
  body: { fontSize: 15, color: colors.text },
  caption: { fontSize: 12, color: colors.textMuted },
} satisfies Record<string, TextStyle>;

/** Shared header look for every stack and tab header. */
export const headerOptions = {
  headerStyle: { backgroundColor: colors.black },
  headerTintColor: colors.white,
  headerTitleStyle: { color: colors.white },
} as const;
