import { deviceStorage } from './deviceStorage';

const USER_ID_KEY = 'rps.userAccountId.v1';
const PROFILE_KEY_KEY = 'rps.localProfileKey.v1';
const GAME_SESSION_ID_KEY = 'rps.activeGameSessionId.v1';
// What the server was last told this browser's push endpoint is, so a rotated
// one can be spotted and re-sent rather than quietly going stale.
const PUSH_ENDPOINT_KEY = 'rps.pushEndpoint.v1';
// When the alerts offer may be shown again. The anti-nag mechanism: dismissing
// it once buys a week of silence, and the fact underneath — that the tab has to
// stay open — is still stated, because that is information rather than a pitch.
const ALERTS_SNOOZED_UNTIL_KEY = 'rps.alertsSnoozedUntil.v1';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const randomByte = () => Math.floor(Math.random() * 256);

export const createUUID = (): string => {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = randomByte();
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
};

export const createProfileKey = (): string => {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = randomByte();
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

// Both identities are settled once per launch and then remembered. The memo is
// not an optimisation: where storage is blocked the fallback is a fresh random
// value, so without it a second caller would be issued a different identity
// from the first.
let cachedUserId: string | null = null;
let cachedProfileKey: string | null = null;

export const getOrCreateUserId = (): string => {
  if (cachedUserId) return cachedUserId;
  const storage = deviceStorage();
  try {
    const existing = storage?.getItem(USER_ID_KEY);
    if (existing && UUID_PATTERN.test(existing)) {
      cachedUserId = existing;
      return cachedUserId;
    }
  } catch {
    // A usable in-memory UUID still lets a device without storage connect.
  }

  cachedUserId = createUUID();
  try {
    storage?.setItem(USER_ID_KEY, cachedUserId);
  } catch {
    // Storage can be unavailable in a private or restricted browser, and a
    // device database can fail to open.
  }
  return cachedUserId;
};

export const getOrCreateProfileKey = (): string => {
  if (cachedProfileKey) return cachedProfileKey;
  const storage = deviceStorage();
  try {
    const existing = storage?.getItem(PROFILE_KEY_KEY);
    if (existing && existing.length >= 32 && existing.length <= 256) {
      cachedProfileKey = existing;
      return cachedProfileKey;
    }
  } catch {
    // An in-memory key still authenticates this session without storage.
  }

  cachedProfileKey = createProfileKey();
  try {
    storage?.setItem(PROFILE_KEY_KEY, cachedProfileKey);
  } catch {
    // The account will last only for this session when storage is unavailable.
  }
  return cachedProfileKey;
};

export const readGameSessionId = (): string | null => {
  try {
    return deviceStorage()?.getItem(GAME_SESSION_ID_KEY) || null;
  } catch {
    return null;
  }
};

export const saveGameSessionId = (gameId: string | null | undefined) => {
  try {
    if (gameId) deviceStorage()?.setItem(GAME_SESSION_ID_KEY, gameId);
  } catch {
    // The live in-memory session remains usable even if persistence is blocked.
  }
};

export const clearGameSessionId = () => {
  try {
    deviceStorage()?.removeItem(GAME_SESSION_ID_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
};

export const readPushEndpoint = (): string | null => {
  try {
    return deviceStorage()?.getItem(PUSH_ENDPOINT_KEY) || null;
  } catch {
    return null;
  }
};

export const savePushEndpoint = (endpoint: string) => {
  try {
    deviceStorage()?.setItem(PUSH_ENDPOINT_KEY, endpoint);
  } catch {
    // Alerts still work; we just cannot notice a rotated endpoint next time.
  }
};

export const clearPushEndpoint = () => {
  try {
    deviceStorage()?.removeItem(PUSH_ENDPOINT_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
};

export const readAlertsSnoozedUntil = (): number => {
  try {
    return Number(deviceStorage()?.getItem(ALERTS_SNOOZED_UNTIL_KEY)) || 0;
  } catch {
    return 0;
  }
};

export const saveAlertsSnoozedUntil = (untilUnixMs: number) => {
  try {
    deviceStorage()?.setItem(ALERTS_SNOOZED_UNTIL_KEY, String(untilUnixMs));
  } catch {
    // Without storage the offer reappears next session, which is the safe way
    // to be wrong: annoying rather than permanently hidden.
  }
};
