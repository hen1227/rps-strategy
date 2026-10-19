// Whether this build reports to Google Analytics at all.
//
// A build-time switch, inlined by Metro like every `EXPO_PUBLIC_*` name, so the
// Node pass that pre-renders each page and the browser agree about it (see
// `featureFlags.ts`). Unset — a fresh checkout, a fork, a development server —
// means no tag, no relay traffic, no consent prompt and no settings row: the
// app behaves exactly as it did before analytics existed.
//
// The ID is public by nature; every page that loads the tag prints it. It goes
// in `frontend/.env.production`. The API secret the apps' events need is the
// server's, never the app's: see `backend/internal/server/google_analytics.go`.
//
// Changing it needs an export with `--clear`, for the cache reason
// `featureFlags.ts` gives.

export const MEASUREMENT_ID = (process.env.EXPO_PUBLIC_GA_MEASUREMENT_ID ?? '').trim();

export const ANALYTICS_AVAILABLE = /^G-[A-Z0-9]+$/.test(MEASUREMENT_ID);
