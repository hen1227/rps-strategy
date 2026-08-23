// One HTTP client for every REST route this app calls.
//
// There used to be five of these: the account, tournament, opening-book,
// review, and bot-registry modules each carried their own `request` with its
// own header handling, its own content-type sniffing, and its own idea of what
// a failure reads like. They had drifted — only two of the five carried the
// status code, which is the one thing a caller needs to tell "your session
// expired" from "the network hiccuped".
//
// What is worth keeping per service is the *voice* of the error message, so
// that is the only thing `apiClient` takes: which server failed to answer.

import { API_URL } from '../serverConfig';

/** A request the server answered with a failure, or could not be asked at all. */
export class ApiError extends Error {
  /** The HTTP status, or `null` when the request never reached the server. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /** Serialised as JSON unless it is already a string. */
  body?: unknown;
  /** A bearer credential: a session token, a profile key, or the host token. */
  token?: string | null;
  /** What the caller was doing, for the failure message: "Loading the game record". */
  what?: string;
  accept?: string;
}

/** A payload with the server's own error message in it. */
const errorMessage = (payload: unknown): string | null => {
  if (typeof payload === 'string') return payload.trim() || null;
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const { error } = payload as { error?: unknown };
    if (typeof error === 'string' && error.trim()) return error;
  }
  return null;
};

/**
 * Bind the client to one server, named as it should appear when it cannot be
 * reached: `apiClient('tournament server')` says "Could not reach the
 * tournament server."
 */
export const apiClient = (service: string) => {
  const unreachable = () => new ApiError(`Could not reach the ${service}.`);

  return async <Result>(path: string, options: RequestOptions = {}): Promise<Result> => {
    const { method = 'GET', body, token, what, accept = 'application/json' } = options;

    const headers: Record<string, string> = { Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        method,
        headers,
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
    } catch (error) {
      // A `fetch` that rejects never reached the server, so there is no status
      // and nothing the caller can retry differently.
      if (error instanceof TypeError) throw unreachable();
      throw error;
    }

    // Every JSON route on the Go side goes through `writeJSON`, which sets the
    // header, so the content type is a reliable way to decide how to read a
    // body — including an error body.
    const contentType = response.headers.get('content-type') ?? '';
    const payload: unknown = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '');

    if (!response.ok) {
      const detail = errorMessage(payload);
      throw new ApiError(
        detail ?? `${what ?? `The request to the ${service}`} failed (${response.status}).`,
        response.status,
      );
    }
    return payload as Result;
  };
};
