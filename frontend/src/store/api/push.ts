// The calls that make a device reachable, of either kind.
//
// HTTP rather than WebSocket messages because registering is a property of the
// *device* rather than of a session: it survives the socket, it is done once,
// and whatever receives the result — a service worker, or iOS itself — outlives
// every tab and every launch. Putting it on the socket would tie "can this
// person be called back" to "is this person currently connected", which is the
// exact coupling the persistent queue exists to break.

import type { PushTransportSupport } from '@/types/protocol';

import { apiClient } from './http';
import { identityCredential, identityScope, type RequestIdentity } from './identity';

const request = apiClient('notification server');

export interface PushKeyResponse {
  /**
   * Whether this server holds VAPID keys, which is what it has always meant to
   * a browser. A phone reads `transports.apns` instead: a deployment can have
   * one and not the other, and each client has to be told about its own half
   * rather than shown the other's answer.
   */
  enabled: boolean;
  publicKey: string;
  transports?: PushTransportSupport;
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
 * Register an iOS device token.
 *
 * The APNs twin of `savePushSubscription`, and separate for the same reason the
 * routes are: a browser hands over a URL and a pair of keys to encrypt for, and
 * a phone hands over a token and nothing else. One call taking either would be
 * a body where half the fields are always ignored.
 */
export const savePushDevice = (token: string, identity: PushIdentity) =>
  request<{ subscribed: boolean }>(`/api/push/devices${identityScope(identity)}`, {
    method: 'POST',
    body: { token },
    token: identityCredential(identity),
    what: 'Turning on alerts',
  });

export const deletePushDevice = (token: string, identity: PushIdentity) =>
  request<{ subscribed: boolean }>(`/api/push/devices${identityScope(identity)}`, {
    method: 'DELETE',
    body: { token },
    token: identityCredential(identity),
    what: 'Turning off alerts',
  });

/**
 * Ask the server to send this device one notification, now.
 *
 * The only way to tell a working subscription from one that stores cleanly and
 * silently delivers nothing — which are otherwise indistinguishable right up
 * until somebody misses a game. `delivered` is how many devices it went to, so
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
