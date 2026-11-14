import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { getAppServices, type AppServices } from './src/platform/services';
import { FixesApp, StartupError } from './src/ui/FixesApp';

type Boot = { services: AppServices; error: null } | { services: null; error: string };

function boot(): Boot {
  try {
    return { services: getAppServices(), error: null };
  } catch (error) {
    // A missing or disallowed EXPO_PUBLIC_API_URL (ConfigError) is a build problem, not a user one.
    console.error('Fixes could not start', error);
    return { services: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export default function App() {
  const [booted] = useState(boot);
  if (!booted.services) {
    return (
      <SafeAreaProvider>
        <StartupError message={booted.error} />
      </SafeAreaProvider>
    );
  }
  return <FixesApp services={booted.services} />;
}
