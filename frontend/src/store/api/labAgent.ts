// Whether this server can run the Lab's agent itself.
//
// One call, and it is allowed to fail: a checkout with no OpenAI key is the
// ordinary case, and so is an older server that has never heard of this route.
// Either way the answer is the same — the page offers to use a key the visitor
// brings — so a failure here is information rather than an error.

import { apiClient } from './http';

const request = apiClient('agent server');

export interface AgentStatus {
  /** Whether the server holds a key. Never anything about the key itself. */
  configured: boolean;
  /** Which model it would run, or empty. */
  model: string;
  maxTurns: number;
  maxWallMs: number;
}

export const getAgentStatus = () =>
  request<AgentStatus>('/api/lab/agent/status', { what: 'Checking for an agent' });
