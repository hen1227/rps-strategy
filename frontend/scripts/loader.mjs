// Let Node import the app's modules unchanged.
//
// Three things differ between Node's resolver and Metro's, and none is worth
// changing production code over:
//
//   `@/…` — the tsconfig path alias. Metro and esbuild both read it from
//   `tsconfig.json`; Node has no idea about it.
//
//   extensionless paths — the app writes `from './analysisGame'`, which Metro
//   resolves and Node does not.
//
//   `react-native`, `expo` and `expo-sqlite/kv-store` — Node resolves the
//   *native* half of every platform-split module, because it knows nothing of
//   Metro's `.web.ts`. So it reaches the native engine session and the device
//   store, neither of which exists here. The arena and the tests inject their
//   own `analyze`, so the engine never runs; storage is answered with a plain
//   in-memory map, which is what a device store does minus the device.
//
// TypeScript itself needs no help beyond a nudge: Node strips types on its own,
// but only for files it already knows are ES modules, and a `.ts` file in a
// package without `"type": "module"` is not one of those. Naming the format in
// the load hook is what makes `.ts` behave here exactly as it does in the app.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REACT_NATIVE_STUB = 'rpsfish-arena:react-native';
const EXPO_STUB = 'rpsfish-arena:expo';
const KV_STORE_STUB = 'rpsfish-arena:kv-store';
const SOURCE_ROOT = pathToFileURL(new URL('../src/', import.meta.url).pathname);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mts'];

export const resolve = async (specifier, context, next) => {
  if (specifier === 'react-native') return { shortCircuit: true, url: REACT_NATIVE_STUB };
  if (specifier === 'expo') return { shortCircuit: true, url: EXPO_STUB };
  if (specifier === 'expo-sqlite/kv-store') return { shortCircuit: true, url: KV_STORE_STUB };

  if (specifier.startsWith('@/')) {
    return resolve(new URL(specifier.slice(2), SOURCE_ROOT).href, context, next);
  }

  try {
    return await next(specifier, context);
  } catch (error) {
    // A directory is reported as its own kind of failure rather than as a
    // missing module, and `modules/rpsfish` is imported as one.
    const recoverable =
      error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT';
    if (!recoverable) throw error;
    if (!specifier.startsWith('.') && !specifier.startsWith('file:')) throw error;
    for (const extension of EXTENSIONS) {
      try {
        return await next(`${specifier}${extension}`, context);
      } catch {
        // Try the next extension; the original error is thrown if none resolve.
      }
    }
    // A directory import, as `from './rpsfish/worker'` would be.
    for (const extension of EXTENSIONS) {
      try {
        return await next(`${specifier}/index${extension}`, context);
      } catch {
        // Fall through to the original failure.
      }
    }
    throw error;
  }
};

export const load = async (url, context, next) => {
  if (url === REACT_NATIVE_STUB) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export const Platform = { OS: "node" };',
    };
  }
  if (url === KV_STORE_STUB) {
    return {
      format: 'module',
      shortCircuit: true,
      source: [
        'const entries = new Map();',
        'export default {',
        '  getItemSync: (key) => (entries.has(key) ? entries.get(key) : null),',
        '  setItemSync: (key, value) => { entries.set(key, String(value)); },',
        '  removeItemSync: (key) => entries.delete(key),',
        '};',
      ].join('\n'),
    };
  }
  if (url === EXPO_STUB) {
    return {
      format: 'module',
      shortCircuit: true,
      // Node has no native modules, which is exactly what the optional form of
      // the lookup is for: the session reports the engine as unavailable
      // instead of throwing on import.
      source: 'export const requireOptionalNativeModule = () => null;',
    };
  }
  // `module-typescript` is Node's own type-stripping format. Naming it here is
  // the whole trick: without it a `.ts` file in this package would be read as
  // CommonJS and its `import` statements would be a syntax error.
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    return {
      format: 'module-typescript',
      shortCircuit: true,
      source: await readFile(new URL(url), 'utf8'),
    };
  }
  return next(url, context);
};
