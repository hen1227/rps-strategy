// Let Node import the app's modules unchanged.
//
// Two things differ between Node's resolver and Metro's, and neither is worth
// changing production code over:
//
//   `react-native` — `engine/rpsfishClient.js` imports `Platform` only to
//   refuse to start a Worker off the web. The arena injects its own `analyze`,
//   so that code never runs, but a static import still has to resolve.
//
//   extensionless paths — the app writes `from './analysisGame'`, which Metro
//   resolves and Node does not.

const STUB_URL = 'rpsfish-arena:react-native';

export const resolve = async (specifier, context, next) => {
  if (specifier === 'react-native') return { shortCircuit: true, url: STUB_URL };
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
    return next(`${specifier}.js`, context);
  }
};

export const load = (url, context, next) =>
  url === STUB_URL
    ? {
        format: 'module',
        shortCircuit: true,
        source: 'export const Platform = { OS: "node" };',
      }
    : next(url, context);
