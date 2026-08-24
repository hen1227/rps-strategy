// The three calls that make a browser reachable.
//
// HTTP rather than WebSocket messages because subscribing is a property of the
// *browser* rather than of a session: it survives the socket, it is done once,
// and the service worker that receives the result outlives every tab. Putting
// it on the socket would tie "can this person be called back" to "is this
// person currently connected", which is the exact coupling the persistent queue
// exists to break.

import { apiClient } from './http';
import { identityCredential, identityScope, type RequestIdentity } from './identity';

const request = apiClient('notification server');

export interface PushKeyResponse {
  enabled: boolean;
  publicKey: string;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Who is asking. A session when signed in, this browser's key otherwise.
 *
 * An alias rather than its own shape: the rule is shared with the bot-series
 * route in `identity.ts`, and this name is what the push modules read as.
 */
export type PushIdentity = RequestIdentity;

export const fetchPushKey = () =>
  request<PushKeyResponse>('/api/push/key', { what: 'Checking whether alerts are available' });

export const savePushSubscription = (
  subscription: PushSubscriptionPayload,
  identity: PushIdentity,
) =>
  request<{ subscribed: boolean }>(`/api/push/subscriptions${identityScope(identity)}`, {
    method: 'POST',
    body: subscription,
    token: identityCredential(identity),
    what: 'Turning on alerts',
  });

/**
 * Ask the server to send this browser one notification, now.
 *
 * The only way to tell a working subscription from one that stores cleanly and
 * silently delivers nothing — which are otherwise indistinguishable right up
 * until somebody misses a game. `delivered` is how many browsers it went to, so
 * zero is a real answer and not a failure.
 */
export const sendTestPush = (identity: PushIdentity) =>
  request<{ delivered: number }>(`/api/push/test${identityScope(identity)}`, {
    method: 'POST',
    body: {},
    token: identityCredential(identity),
    what: 'Sending a test notification',
  });

export const deletePushSubscription = (endpoint: string, identity: PushIdentity) =>
  request<{ subscribed: boolean }>(`/api/push/subscriptions${identityScope(identity)}`, {
    method: 'DELETE',
    body: { endpoint },
    token: identityCredential(identity),
    what: 'Turning off alerts',
  });
