import { apiClient } from './http';
import type {
  OpeningBookBootstrap,
  OpeningLine,
  OpeningName,
  OpeningNameSuggestion,
  OpeningNamingInput,
  OpeningNodeResponse,
} from '@/engine/openingBook';
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
