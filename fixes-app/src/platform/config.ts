import { resolveApiConfig, type ApiConfig } from '../core/config';

/**
 * The only place that reads the environment. `process.env.EXPO_PUBLIC_API_URL` must stay a static
 * member expression: Metro inlines it at build time. Release builds (`__DEV__ === false`) refuse
 * anything but https (protocol §3).
 */
export function loadApiConfig(): ApiConfig {
  return resolveApiConfig(process.env.EXPO_PUBLIC_API_URL, { release: !__DEV__ });
}
