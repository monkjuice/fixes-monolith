import { Image, StyleSheet } from 'react-native';

/** The legacy fixesLogo.png, 200 pt wide as on the legacy login page. */
export function Logo() {
  return (
    <Image
      source={require('../../../assets/fixesLogo.png')}
      style={styles.logo}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="Fixes"
    />
  );
}

const styles = StyleSheet.create({ logo: { width: 200, height: 80, alignSelf: 'center' } });
