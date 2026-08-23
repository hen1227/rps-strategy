import { apiClient } from './http';
import type {
  OpeningBookDocument,
  OpeningLine,
  OpeningName,
  OpeningNameSuggestion,
  PublishedOpeningBook,
} from '@/engine/openingBook';
import type { ModeID } from '@/types/game';

const request = apiClient('opening-book server');

const modePath = (modeId: ModeID) => encodeURIComponent(modeId);

export const getOpeningBook = (modeId: ModeID) =>
  request<PublishedOpeningBook>(`/api/openings/${modePath(modeId)}`, {
    what: 'Loading the opening book',
  });

export const importOpeningBook = (
  adminToken: string,
  modeId: ModeID,
  document: OpeningBookDocument | string,
) =>
  request<PublishedOpeningBook>(`/api/admin/openings/${modePath(modeId)}`, {
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
