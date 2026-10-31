import Constants from 'expo-constants';
import { Platform } from 'react-native';

// The apps' half of `clientBuild.ts`: the version this build was published as,
// from app.json, which the server compares with its minimum for the platform.

export const appVersion = (): string => (Constants.expoConfig?.version ?? '').trim();

/** `ios`, `android` or `web`, by the names the server's version check uses. */
export const appPlatform = (): string => Platform.OS;
