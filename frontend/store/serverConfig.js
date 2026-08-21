export const WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? 'ws://localhost:8080/ws';

const apiURLFromWebSocket = (webSocketURL) =>
  webSocketURL
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/ws(?:\?.*)?$/, '');

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? apiURLFromWebSocket(WS_URL)
).replace(/\/$/, '');
