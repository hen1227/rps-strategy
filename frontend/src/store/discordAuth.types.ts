// The contract the two halves of Discord sign-in are held to.
//
// Platform files are resolved by the bundler and never see each other, so a
// shared declaration is the only thing that can keep them in step. Same
// arrangement as `deviceStorage.types.ts` next door, for the same reason.
//
// The return address and its parser are not Discord's alone — Apple's sign-in
// on the website comes back the same way — so they live in `signInReturn.ts`.
// The address is still exported from here as well, for the app layout, which
// held the callback route open by this name before Apple and need not move.

export { ACCOUNT_CALLBACK_PATH } from './signInReturn';

/**
 * What came of asking Discord.
 *
 * `pending` is the web answer and means "this page is going away" — the
 * redirect has been issued and nothing follows it, so there is deliberately no
 * ticket to return. Native resolves to `ticket` instead, because the sheet
 * closes and control comes back here.
 */
export type DiscordOutcome =
  | { kind: 'pending' }
  | { kind: 'ticket'; ticket: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * Turn this platform's own return address into the URL to open.
 *
 * Passed *in* rather than the address being passed *out*, so each half owns its
 * return address end to end: the web build knows its origin and the native
 * build knows its scheme, and neither has to be told by code that cannot know.
 */
export type Authorize = (redirectUri: string) => Promise<string>;

export interface DiscordAuth {
  /**
   * Whether this build can sign in with Discord at all.
   *
   * A real question on native, where the JavaScript may be running inside a
   * binary built before the browser module was added. Screens ask this rather
   * than which platform they are on, the same way they ask
   * `isEngineAvailable()`.
   */
  isDiscordSignInAvailable(): boolean;
  signInThroughDiscord(authorize: Authorize): Promise<DiscordOutcome>;
}
