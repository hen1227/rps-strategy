// Who is asking, on a route that will take either answer.
//
// Most routes want one credential or the other and say so: editing a profile
// needs a login, storing a review needs only the key that played the game. A few
// take whichever there is, because the thing being asked for belongs to a
// *browser* rather than to an account — turning on alerts, and pitting two bots
// against each other. Both of those are most wanted by the visitor who never
// registered, so refusing them would leave the feature to the people who need it
// least.
//
// The rule lives here rather than in each of those modules because it is one
// rule with a matching rule on the server (`requireAnyIdentity`), and two copies
// of it would be two things to keep in step with one.

/** A login when there is one, this browser's own account otherwise. */
export interface RequestIdentity {
  userId: string;
  profileKey: string;
  sessionToken: string | null;
}

/** The bearer credential to send: the session if signed in, else the key. */
export const identityCredential = (identity: RequestIdentity) =>
  identity.sessionToken ?? identity.profileKey;

/**
 * The query suffix that says whose key this is.
 *
 * A profile key does not carry an account id, and the server has to look the
 * account up to verify the key against it. A session token does, so it needs no
 * suffix — and sending one anyway would invite the reading that the caller gets
 * to choose which account it is acting as.
 */
export const identityScope = (identity: RequestIdentity, separator = '?') =>
  identity.sessionToken ? '' : `${separator}userId=${encodeURIComponent(identity.userId)}`;
