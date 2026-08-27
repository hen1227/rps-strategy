// Curating the book: the four writes an administrator has, in one place.
//
// Naming a line, unnaming it, publishing somebody's proposal and turning one
// down are the same act from four buttons -- and each of them changes both the
// names and the queue. Keeping them here means every surface that offers one
// gets the same busy state, the same error, and the same already-applied page
// afterwards, rather than each panel doing its own half of it.

import { useCallback, useState } from 'react';

import {
  withPublishedName,
  withoutOpeningName,
  withoutSuggestion,
  type OpeningBookBootstrap,
  type OpeningLine,
  type OpeningNameSuggestion,
} from '@/engine/openingBook';
import { failureMessage } from '@/errors';
import { useAdminToken, type AdminToken } from '@/hooks/useAdminToken';
import {
  approveOpeningNameSuggestion,
  deleteOpeningName,
  rejectOpeningNameSuggestion,
  setOpeningName,
} from '@/store/api/openings';
import type { ModeID } from '@/types/game';

/** What a curating surface can do, and what it should draw while doing it. */
export interface OpeningCurator {
  /** The credential, whichever door it came through. */
  admin: AdminToken;
  /** True when curator controls belong on screen: unlocked, and switched on. */
  active: boolean;
  /** True when this visitor could turn them on. */
  available: boolean;
  setActive: (on: boolean) => void;
  /** Which action is in flight, as `approve:12` or `publish:d8-c7`. */
  busy: string | null;
  error: string | null;
  dismissError: () => void;
  publish: (line: OpeningLine, name: string) => Promise<boolean>;
  remove: (line: OpeningLine) => Promise<boolean>;
  approve: (suggestion: OpeningNameSuggestion) => Promise<boolean>;
  reject: (suggestion: OpeningNameSuggestion) => Promise<boolean>;
}

export type OpeningBookUpdate = (
  change: (book: OpeningBookBootstrap) => OpeningBookBootstrap,
) => void;

export const useOpeningCurator = (
  modeId: ModeID,
  update: OpeningBookUpdate,
  notify: (message: string) => void,
): OpeningCurator => {
  const admin = useAdminToken();
  // On by default for somebody who is already an administrator: they came here
  // to curate, and hunting for a switch first is the thing this replaces. It
  // is still a switch, because reading the book past a page of inputs is not.
  const [wanted, setWanted] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = admin.token;

  const run = useCallback(
    async <Result,>(key: string, act: () => Promise<Result>, done: (result: Result) => void) => {
      setBusy(key);
      setError(null);
      try {
        done(await act());
        return true;
      } catch (requestError) {
        setError(failureMessage(requestError));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const publish = useCallback(
    (line: OpeningLine, name: string) =>
      run(
        `publish:${line.join(' ')}`,
        () => setOpeningName(token, modeId, line, name.trim()),
        (published) => {
          update((book) => withPublishedName(book, published));
          notify(`Published “${published.name}”.`);
        },
      ),
    [modeId, notify, run, token, update],
  );

  const remove = useCallback(
    (line: OpeningLine) =>
      run(
        `remove:${line.join(' ')}`,
        () => deleteOpeningName(token, modeId, line),
        () => {
          update((book) => withoutOpeningName(book, line));
          notify('The name was removed; the line is unnamed again.');
        },
      ),
    [modeId, notify, run, token, update],
  );

  const approve = useCallback(
    (suggestion: OpeningNameSuggestion) =>
      run(
        `approve:${suggestion.suggestionId}`,
        () => approveOpeningNameSuggestion(token, modeId, suggestion.suggestionId),
        (published) => {
          update((book) => withPublishedName(book, published));
          notify(`Published “${published.name}”.`);
        },
      ),
    [modeId, notify, run, token, update],
  );

  const reject = useCallback(
    (suggestion: OpeningNameSuggestion) =>
      run(
        `reject:${suggestion.suggestionId}`,
        () => rejectOpeningNameSuggestion(token, modeId, suggestion.suggestionId),
        () => {
          update((book) => withoutSuggestion(book, suggestion.suggestionId));
          notify(`Turned down “${suggestion.name}”.`);
        },
      ),
    [modeId, notify, run, token, update],
  );

  return {
    admin,
    active: admin.unlocked && wanted,
    available: admin.unlocked,
    setActive: setWanted,
    busy,
    error,
    dismissError: () => setError(null),
    publish,
    remove,
    approve,
    reject,
  };
};
