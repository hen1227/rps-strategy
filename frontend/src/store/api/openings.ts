import { apiClient } from './http';
import type {
  OpeningBookBootstrap,
  OpeningBookUpload,
  OpeningLine,
  OpeningName,
  OpeningNameSuggestion,
  OpeningBookMeta,
  OpeningNodeResponse,
} from '@/engine/openingBook';
import type { ModeID } from '@/types/game';

const request = apiClient('opening-book server');

const modePath = (modeId: ModeID) => encodeURIComponent(modeId);

/**
 * The book's front page: metadata, names, the opening position, and the
 * positions along the featured lines. Not the book -- the server keeps that.
 */
export const getOpeningBook = (modeId: ModeID) =>
  request<OpeningBookBootstrap>(`/api/openings/${modePath(modeId)}`, {
    what: 'Loading the opening book',
  });

/** One position, named by the line that reaches it. */
export const getOpeningNode = (modeId: ModeID, line: OpeningLine) =>
  request<OpeningNodeResponse>(
    `/api/openings/${modePath(modeId)}/node?line=${encodeURIComponent(line.join(','))}`,
    { what: 'Loading the position' },
  );

export const importOpeningBook = (
  adminToken: string,
  modeId: ModeID,
  document: OpeningBookUpload | string,
) =>
  request<OpeningBookMeta>(`/api/admin/openings/${modePath(modeId)}`, {
    method: 'PUT',
    body: document,
    token: adminToken,
    what: 'Importing the opening book',
  });

export const suggestOpeningName = (modeId: ModeID, line: OpeningLine, name: string) =>
  request<OpeningNameSuggestion>(`/api/openings/${modePath(modeId)}/suggestions`, {
    method: 'POST',
    body: { line, name },
    what: 'Suggesting a name',
  });

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

export const getOpeningNameSuggestions = (adminToken: string, modeId: ModeID) =>
  request<OpeningNameSuggestion[]>(`/api/admin/openings/${modePath(modeId)}/suggestions`, {
    token: adminToken,
    what: 'Loading name suggestions',
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
    { method: 'POST', token: adminToken, what: 'Approving the name' },
  );
