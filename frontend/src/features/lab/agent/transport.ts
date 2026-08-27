// Where the bytes come from: our relay, or this browser talking to OpenAI.
//
// The two are deliberately interchangeable. The relay copies SSE lines without
// understanding them, so both transports emit the same frames and the loop above
// cannot tell which one it is holding — one parser, one set of tests, and a demo
// that works whether or not the server has a key.
//
// Which one you get:
//
//  * **Proxy**, when the server reports a key. Nothing secret reaches the page,
//    and a visitor with no OpenAI account can still use the Lab.
//  * **Direct**, with a key the user pasted. It is kept in this browser and sent
//    to `api.openai.com` and nowhere else — never to our server, which is the
//    whole point of offering it.

import { fetch as streamingFetch } from 'expo/fetch';

import { API_URL } from '@/store/serverConfig';
import { identityCredential, identityScope, type RequestIdentity } from '@/store/api/identity';

import { parseUpstreamEvent, sseFrames, type AgentRequest, type AgentTransport, type UpstreamEvent } from './wire';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** The default when nothing else says otherwise. Override in the key sheet. */
export const DEFAULT_MODEL = 'gpt-5.6-terra';

/** What OpenAI is asked for, minus the parts a relay pins on the server. */
const requestBody = (request: AgentRequest) => ({
  instructions: request.instructions,
  input: request.input,
  tools: request.tools,
  // One tool at a time. The Lab's tools are stateful — `lab_patch_spec` ends the
  // test game — so a batch that edits the rules and then moves a piece is a
  // batch whose second half cannot run. The loop copes either way; this stops it
  // having to.
  parallel_tool_calls: false,
});

const failure = async (response: Response, fallback: string): Promise<never> => {
  let detail = '';
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    detail = parsed?.error?.message ?? text.slice(0, 300);
  } catch {
    detail = '';
  }
  throw new Error(detail ? `${fallback}: ${detail}` : `${fallback} (HTTP ${response.status}).`);
};

/** The frames of a response body, as events the loop understands. */
async function* eventsOf(response: Response): AsyncGenerator<UpstreamEvent> {
  const body = response.body as unknown as AsyncIterable<Uint8Array> | null;
  if (!body) {
    // No streaming here — read it whole and replay it. Slower to appear, but a
    // browser that cannot stream should still be able to use the Lab.
    const whole = await response.text();
    for await (const frame of sseFrames((async function* () { yield whole; })())) {
      const event = parseUpstreamEvent(frame.event, frame.data);
      if (event) yield event;
    }
    return;
  }
  for await (const frame of sseFrames(body)) {
    const event = parseUpstreamEvent(frame.event, frame.data);
    if (event) yield event;
  }
}

/**
 * Straight to OpenAI, with a key the person at the keyboard owns.
 *
 * Checked rather than assumed: `api.openai.com` answers a preflight with
 * `access-control-allow-origin: *` and allows the `authorization` header, so
 * this needs no server of ours at all.
 */
export const directTransport = (options: { apiKey: string; model?: string }): AgentTransport => ({
  kind: 'direct',
  async *stream(request, signal) {
    const response = (await streamingFetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        stream: true,
        // Nothing is kept on OpenAI's side, so the conversation this page holds
        // is the only copy — which is what makes the two transports equivalent.
        store: false,
        // Reasoning has to make the round trip or the model forgets why it
        // called the tool it just called. With `store: false` that means asking
        // for it encrypted, because there is no id to point at instead.
        include: ['reasoning.encrypted_content'],
        ...requestBody(request),
      }),
      signal,
    })) as unknown as Response;

    if (!response.ok) await failure(response, 'OpenAI refused that request');
    yield* eventsOf(response);
  },
});

/**
 * Through our own server, which holds the key.
 *
 * The server is a relay and nothing more: it pins the model, refuses to store
 * anything, and copies frames back. It keeps no conversation, so it cannot drift
 * from what this page actually did.
 */
export const proxyTransport = (identity: RequestIdentity): AgentTransport => ({
  kind: 'proxy',
  async *stream(request, signal) {
    const response = (await streamingFetch(
      `${API_URL}/api/lab/agent/stream${identityScope(identity)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${identityCredential(identity)}`,
        },
        body: JSON.stringify(requestBody(request)),
        signal,
      },
    )) as unknown as Response;

    if (!response.ok) await failure(response, 'The agent server could not run that');
    yield* eventsOf(response);
  },
});
