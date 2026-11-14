import { NavigationContainer, type InitialState } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render } from '@testing-library/react-native';
import type { ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FixesProvider, type FixesServices } from '../../../hooks';
import { ToastProvider } from '../../components';
import { FriendRequestCountProvider } from '../../hooks/useFriendRequestCount';
import type { RootStackParamList } from '../../navigation/types';

const ROUTES: readonly (keyof RootStackParamList)[] = [
  'Main',
  'Conversation',
  'NewConversation',
  'UserProfile',
  'EditProfile',
  'FriendRequests',
  'Settings',
  'Devices',
  'LinkDevice',
  'ReceiveHistory',
  'Backup',
  'Security',
  'ChangePassword',
];

/** Every other route: shows its name and params, so tests can assert where a screen navigated. */
function StubScreen({ route }: { route: { name: string; params?: object } }) {
  return <Text testID={`stub-${route.name}`}>{JSON.stringify(route.params ?? null)}</Text>;
}

/**
 * Renders one stack screen with the app's providers, on top of a stub "Main" (so goBack works) and any
 * `below` routes, with every other route stubbed. For whole-app flows render FixesApp instead.
 */
export function renderScreen<Name extends keyof RootStackParamList>(
  name: Name,
  component: ComponentType<never>,
  services: FixesServices,
  params?: RootStackParamList[Name],
  options: { below?: { name: keyof RootStackParamList; params?: object }[] } = {},
) {
  const Stack = createNativeStackNavigator<RootStackParamList>();
  const routes = [{ name: 'Main' }, ...(options.below ?? []), { name, params: params as object | undefined }];
  const initialState: InitialState = { index: routes.length - 1, routes };
  return render(
    <SafeAreaProvider>
      <FixesProvider services={services}>
        <ToastProvider>
          <FriendRequestCountProvider>
            <NavigationContainer initialState={initialState}>
              <Stack.Navigator>
                {ROUTES.map((route) => (
                  <Stack.Screen
                    key={route}
                    name={route}
                    component={(route === name ? component : StubScreen) as ComponentType<object>}
                  />
                ))}
              </Stack.Navigator>
            </NavigationContainer>
          </FriendRequestCountProvider>
        </ToastProvider>
      </FixesProvider>
    </SafeAreaProvider>,
  );
}

/** Same services object for a real test phone (SessionManager + engine + backups). */
export function servicesOfPhone(phone: {
  session: FixesServices['session'];
  engine: FixesServices['messaging'];
  backup: FixesServices['backup'];
}): FixesServices {
  return { session: phone.session, messaging: phone.engine, backup: phone.backup };
}
