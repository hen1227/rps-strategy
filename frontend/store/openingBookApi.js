import { API_URL } from './serverConfig';

const request = async (path, { method = 'GET', body, adminToken } = {}) => {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the opening-book server.');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    const message = payload?.error || (typeof payload === 'string' && payload.trim());
    const error = new Error(message || `Opening-book request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
};

const modePath = (modeId) => encodeURIComponent(modeId);

export const getOpeningBook = (modeId) => request(`/api/openings/${modePath(modeId)}`);

export const importOpeningBook = (adminToken, modeId, document) =>
  request(`/api/admin/openings/${modePath(modeId)}`, {
    method: 'PUT',
    body: document,
    adminToken,
  });

export const suggestOpeningName = (modeId, line, name) =>
  request(`/api/openings/${modePath(modeId)}/suggestions`, {
    method: 'POST',
    body: { line, name },
  });

export const setOpeningName = (adminToken, modeId, line, name) =>
  request(`/api/admin/openings/${modePath(modeId)}/names`, {
    method: 'PUT',
    body: { line, name },
    adminToken,
  });

export const getOpeningNameSuggestions = (adminToken, modeId) =>
  request(`/api/admin/openings/${modePath(modeId)}/suggestions`, { adminToken });

export const approveOpeningNameSuggestion = (adminToken, modeId, suggestionId) =>
  request(
    `/api/admin/openings/${modePath(modeId)}/suggestions/${encodeURIComponent(
      suggestionId,
    )}/approve`,
    { method: 'POST', adminToken },
  );
