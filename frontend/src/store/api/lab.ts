// The mode library, over HTTP.
//
// Everything the Lab and the library page ask the server for. The rules
// themselves never travel any other way: a published spec is what a game carries
// and what a fork starts from, so these calls are the whole of how a mode gets
// from the person who wrote it to the person who plays it.

import { apiClient } from './http';
import { identityCredential, identityScope, type RequestIdentity } from './identity';
import type { RuleSpec } from '@/engine/spec/types';

const request = apiClient('mode library');

/** One published mode, as the library lists it. */
export interface LibraryMode {
  modeId: string;
  slug: string;
  version: number;
  ownerUserId: string;
  ownerUsername?: string;
  name: string;
  shortCode: string;
  description: string;
  objective: string;
  spec: RuleSpec;
  /** The reusable parts this was built from, for credit. */
  derivedFrom?: string[];
  visibility: 'public' | 'unlisted';
  plays: number;
  publishedAtUnixMs: number;
  retiredAtUnixMs?: number;
}

/** A published, parameterised fragment of the rule language. */
export interface LibraryPart {
  partId: string;
  version: number;
  ownerUserId: string;
  ownerUsername?: string;
  kind: 'movement' | 'capture' | 'effect' | 'win' | 'draw' | 'turn';
  name: string;
  summary: string;
  params?: Record<string, { type: string; default?: unknown }>;
  body: unknown;
  usedBy: number;
  publishedAtUnixMs: number;
}

export interface LabDraft {
  draftId: string;
  name: string;
  spec: RuleSpec;
  updatedAtUnixMs: number;
}

export interface ListModesOptions {
  search?: string;
  /** Somebody's own shelf, which includes their unlisted modes. */
  mine?: boolean;
  limit?: number;
  offset?: number;
}

const query = (parts: Record<string, string | number | undefined>) => {
  const pairs = Object.entries(parts)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
};

export const listLibraryModes = (
  options: ListModesOptions = {},
  identity?: RequestIdentity,
) => {
  const suffix = query({
    q: options.search,
    mine: options.mine ? 1 : undefined,
    limit: options.limit,
    offset: options.offset,
  });
  const scope = identity && options.mine ? identityScope(identity, suffix ? '&' : '?') : '';
  return request<{ modes: LibraryMode[] }>(`/api/lab/modes${suffix}${scope}`, {
    token: identity && options.mine ? identityCredential(identity) : undefined,
    what: 'Loading the mode library',
  });
};

export const getLibraryMode = (modeId: string) =>
  request<{ mode: LibraryMode }>(`/api/lab/modes/${encodeURIComponent(modeId)}`, {
    what: 'Loading that mode',
  });

export interface PublishModeInput {
  /** The short name the mode is addressed by. Lower-cased by the server. */
  slug: string;
  spec: RuleSpec;
  derivedFrom?: string[];
  visibility?: 'public' | 'unlisted';
}

export const publishMode = (input: PublishModeInput, identity: RequestIdentity) =>
  request<{ mode: LibraryMode }>(`/api/lab/modes${identityScope(identity)}`, {
    method: 'POST',
    body: input,
    token: identityCredential(identity),
    what: 'Publishing this mode',
  });

export const retireMode = (modeId: string, identity: RequestIdentity) =>
  request<void>(
    `/api/lab/modes/${encodeURIComponent(modeId)}${identityScope(identity)}`,
    { method: 'DELETE', token: identityCredential(identity), what: 'Retiring that mode' },
  );

export const listRuleParts = (options: { kind?: string; search?: string; limit?: number } = {}) =>
  request<{ parts: LibraryPart[] }>(
    `/api/lab/parts${query({ kind: options.kind, q: options.search, limit: options.limit })}`,
    { what: 'Searching reusable parts' },
  );

/** `jump` for the newest, `jump@1` for a particular version. */
export const getRulePart = (partId: string) =>
  request<{ part: LibraryPart }>(`/api/lab/parts/${encodeURIComponent(partId)}`, {
    what: 'Loading that part',
  });

export interface PublishPartInput {
  partId: string;
  kind: LibraryPart['kind'];
  name: string;
  summary: string;
  params?: Record<string, unknown>;
  body: unknown;
}

export const publishRulePart = (input: PublishPartInput, identity: RequestIdentity) =>
  request<{ part: LibraryPart }>(`/api/lab/parts${identityScope(identity)}`, {
    method: 'POST',
    body: input,
    token: identityCredential(identity),
    what: 'Publishing this part',
  });

export const listDrafts = (identity: RequestIdentity) =>
  request<{ drafts: LabDraft[] }>(`/api/lab/drafts${identityScope(identity)}`, {
    token: identityCredential(identity),
    what: 'Loading your drafts',
  });

export const saveDraft = (
  draft: { draftId: string; name: string; spec: RuleSpec },
  identity: RequestIdentity,
) =>
  request<void>(`/api/lab/drafts${identityScope(identity)}`, {
    method: 'PUT',
    body: draft,
    token: identityCredential(identity),
    what: 'Saving this draft',
  });

export const deleteDraft = (draftId: string, identity: RequestIdentity) =>
  request<void>(
    `/api/lab/drafts/${encodeURIComponent(draftId)}${identityScope(identity)}`,
    { method: 'DELETE', token: identityCredential(identity), what: 'Deleting that draft' },
  );

/**
 * The rule language, as the build that will judge a spec describes it.
 *
 * Fetched rather than bundled, deliberately: the agent designing a mode should
 * be reading the reference from the server that is going to validate what it
 * writes, not from whatever this bundle was built with.
 */
export const getLanguageReference = () =>
  request<string>('/api/lab/language', {
    accept: 'text/markdown',
    what: 'Loading the rule language reference',
  });

/* ---------------------------------------------------------------- pictures -- */

/**
 * A picture stored on the server, as the Lab sees it.
 *
 * `artId` is the whole of the reference: it is what goes into a spec's `art`,
 * `board.art` or `cover`, and it is the digest of the picture's own bytes, so
 * it can never come to mean a different picture.
 */
export interface LabArtAsset {
  artId: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  role: 'piece' | 'board' | 'cover';
  published: boolean;
  createdAtUnixMs: number;
}

export interface AddArtInput {
  role: 'piece' | 'board' | 'cover';
  /** The picture itself, base64. Give this or `url`, not both. */
  data?: string;
  /** A URL for the server to fetch it from. Give this or `data`, not both. */
  url?: string;
}

/**
 * Store a picture. Needs a real account — a session token, not a profile key —
 * because it is the one thing the Lab makes that this server then hosts and
 * serves to strangers.
 */
export const addLabArt = (input: AddArtInput, identity: RequestIdentity) =>
  request<{ art: LabArtAsset; url: string }>(`/api/lab/art`, {
    method: 'POST',
    body: input,
    token: identityCredential(identity),
    what: 'Adding that picture',
  });

/** The pictures this account already has, newest first. */
export const listLabArt = (identity: RequestIdentity) =>
  request<{ art: { art: LabArtAsset; url: string }[] }>(`/api/lab/art`, {
    token: identityCredential(identity),
    what: 'Listing your pictures',
  });
