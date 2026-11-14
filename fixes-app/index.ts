// Must stay the first import: it installs crypto.getRandomValues, which every @noble module and all
// key/nonce/id generation rely on (protocol §2). Anything imported above it could load @noble first.
import 'react-native-get-random-values';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App) and sets up the
// environment for both development and release builds.
registerRootComponent(App);
