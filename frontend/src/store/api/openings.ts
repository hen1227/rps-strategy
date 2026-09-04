import { apiClient } from './http';
import type {
  OpeningBookBootstrap,
  OpeningLine,
  OpeningName,
  OpeningNamePage,
  OpeningNameSource,
  OpeningNameSuggestion,
  OpeningNamingInput,
  OpeningNodeResponse,
} from '@/engine/openingBook';
import type { OpeningCohort, OpeningStatsNode } from '@/engine/openingStats';
import type { ModeID } from '@/types/game';

const request = apiClient('opening-book server');

const modePath = (modeId: ModeID) => encodeURIComponent(modeId);

const linePath = (line: OpeningLine) => encodeURIComponent(line.join(','));

/**
 * The book's front page: metadata, names, open name suggestions, the opening
 * position, and the positions along the featured lines. Not the book -- the
 * server keeps that.
 */
export const getOpeningBook = (modeId: ModeID) =>
  request<OpeningBookBootstrap>(`/api/openings/${modePath(modeId)}`, {
    what: 'Loading the opening book',
  });

/**
 * The naming layer on its own: what lines are called, and whether mirror twins
 * share a name. Fed straight to `openingNaming`.
 *
 * The bootstrap above answers the same question and brings a book's worth of
 * positions with it. The live board only wants to know what the game on screen
 * is called, and it asks for every game, so it asks here instead.
 */
export const getOpeningNames = (modeId: ModeID) =>
  request<OpeningNamingInput & { modeId: string }>(
    `/api/openings/${modePath(modeId)}/names`,
    { what: 'Loading opening names' },
  );

/** One position, named by the line that reaches it. */
export const getOpeningNode = (modeId: ModeID, line: OpeningLine) =>
  request<OpeningNodeResponse>(
    `/api/openings/${modePath(modeId)}/node?line=${linePath(line)}`,
    { what: 'Loading the position' },
  );

/**
 * Every name people have put forward and nobody has published.
 *
 * Public, like the names themselves: an unnamed line shows what it has been
 * called so far, rather than an empty box that gives no sign the question was
 * ever asked.
 */
export const getOpeningNameSuggestions = (modeId: ModeID) =>
  request<OpeningNameSuggestion[]>(`/api/openings/${modePath(modeId)}/suggestions`, {
    what: 'Loading name suggestions',
  });

export const suggestOpeningName = (modeId: ModeID, line: OpeningLine, name: string) =>
  request<OpeningNameSuggestion>(`/api/openings/${modePath(modeId)}/suggestions`, {
    method: 'POST',
    body: { line, name },
    what: 'Suggesting a name',
  });

/**
 * Publish a name for a line. The server stores it against whichever of the
 * line and its mirror is the canonical one, so the returned name may read as
 * the other half of the pair -- the same opening, drawn the other way round.
 */
export const setOpeningName = (
  adminToken: string,
  modeId: ModeID,
  line: OpeningLine,
  name: string,
) =>
  request<OpeningName>(`/api/admin/openings/${modePath(modeId)}/names`, {
    method: 'PUT',
    body: { line, name },
    token: adminToken,
    what: 'Publishing the name',
  });

/** Take a published name back off a line, leaving it unnamed again. */
export const deleteOpeningName = (adminToken: string, modeId: ModeID, line: OpeningLine) =>
  request<void>(`/api/admin/openings/${modePath(modeId)}/names?line=${linePath(line)}`, {
    method: 'DELETE',
    token: adminToken,
    what: 'Removing the name',
  });

export const approveOpeningNameSuggestion = (
  adminToken: string,
  modeId: ModeID,
  suggestionId: number,
) =>
  request<OpeningName>(
    `/api/admin/openings/${modePath(modeId)}/suggestions/${encodeURIComponent(
      String(suggestionId),
    )}/approve`,
    { method: 'POST', token: adminToken, what: 'Publishing the name' },
  );

/** Turn one proposal down, without naming the line. */
export const rejectOpeningNameSuggestion = (
  adminToken: string,
  modeId: ModeID,
  suggestionId: number,
) =>
  request<void>(
    `/api/admin/openings/${modePath(modeId)}/suggestions/${encodeURIComponent(
      String(suggestionId),
    )}`,
    { method: 'DELETE', token: adminToken, what: 'Turning down the name' },
  );

/**
 * Name a line, published immediately.
 *
 * Not a suggestion: the line is checked against the *rules* rather than
 * against the book, so an opening RPSFish never analyzed can be named -- which
 * is most of the interesting ones. A 409 means somebody named it first, and
 * the caller's move then is to suggest an alternative.
 */
export const nameOpeningLine = (modeId: ModeID, line: OpeningLine, name: string) =>
  request<OpeningName>(`/api/openings/${modePath(modeId)}/names`, {
    method: 'POST',
    body: { line, name },
    what: 'Naming the opening',
  });

/**
 * The searchable index of every named opening.
 *
 * The book page leads with the engine's certified lines and does not list
 * player names beside them, so this is how they stay findable rather than
 * merely stored.
 */
export const browseOpeningNames = (
  modeId: ModeID,
  options: { source?: OpeningNameSource; query?: string; limit?: number; offset?: number } = {},
) => {
  const parameters = new URLSearchParams();
  if (options.source) parameters.set('source', options.source);
  if (options.query) parameters.set('q', options.query);
  if (options.limit) parameters.set('limit', String(options.limit));
  if (options.offset) parameters.set('offset', String(options.offset));
  const query = parameters.toString();
  return request<OpeningNamePage>(
    `/api/openings/${modePath(modeId)}/names/browse${query ? `?${query}` : ''}`,
    { what: 'Loading named openings' },
  );
};

/**
 * What people play, compiled from the archive daily.
 *
 * With no line this is the whole condensed dataset for a mode -- totals, the
 * first-move breakdown with a share on each, and the most played lines -- in
 * one request. A 404 means no compile has run yet, which reads differently
 * from a compile that found no games and is why the caller is told apart.
 */
export const getOpeningStats = (
  modeId: ModeID,
  options: { cohort?: OpeningCohort; line?: OpeningLine } = {},
) => {
  const parameters = new URLSearchParams();
  if (options.cohort) parameters.set('cohort', options.cohort);
  if (options.line?.length) parameters.set('line', options.line.join(','));
  const query = parameters.toString();
  return request<OpeningStatsNode>(
    `/api/openings/${modePath(modeId)}/stats${query ? `?${query}` : ''}`,
    { what: 'Loading what people play' },
  );
};
