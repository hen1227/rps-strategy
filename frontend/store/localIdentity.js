const USER_ID_KEY = 'rps.userAccountId.v1';
const PROFILE_KEY_KEY = 'rps.localProfileKey.v1';
const GAME_SESSION_ID_KEY = 'rps.activeGameSessionId.v1';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const localStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const randomByte = () => Math.floor(Math.random() * 256);

export const createUUID = () => {
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

export const createProfileKey = () => {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = randomByte();
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const getOrCreateUserId = () => {
  const storage = localStorage();
  try {
    const existing = storage?.getItem(USER_ID_KEY);
    if (existing && UUID_PATTERN.test(existing)) return existing;
  } catch {
    // A usable in-memory UUID still lets restricted browser contexts connect.
  }

  const userId = createUUID();
  try {
    storage?.setItem(USER_ID_KEY, userId);
  } catch {
    // localStorage can be unavailable in private or restricted contexts.
  }
  return userId;
};

export const getOrCreateProfileKey = () => {
  const storage = localStorage();
  try {
    const existing = storage?.getItem(PROFILE_KEY_KEY);
    if (existing && existing.length >= 32 && existing.length <= 256) return existing;
  } catch {
    // An in-memory key still authenticates this tab in restricted contexts.
  }

  const profileKey = createProfileKey();
  try {
    storage?.setItem(PROFILE_KEY_KEY, profileKey);
  } catch {
    // The account will last only for this tab when localStorage is unavailable.
  }
  return profileKey;
};

export const readGameSessionId = () => {
  try {
    return localStorage()?.getItem(GAME_SESSION_ID_KEY) || null;
  } catch {
    return null;
  }
};

export const saveGameSessionId = (gameId) => {
  try {
    if (gameId) localStorage()?.setItem(GAME_SESSION_ID_KEY, gameId);
  } catch {
    // The live in-memory session remains usable even if persistence is blocked.
  }
};

export const clearGameSessionId = () => {
  try {
    localStorage()?.removeItem(GAME_SESSION_ID_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
};
