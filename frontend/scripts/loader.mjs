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
//   `react-native` — `engine/rpsfish/client.ts` imports `Platform` only to
//   refuse to start a Worker off the web. The arena injects its own `analyze`,
//   so that code never runs, but a static import still has to resolve.
//
// TypeScript itself needs no help beyond a nudge: Node strips types on its own,
// but only for files it already knows are ES modules, and a `.ts` file in a
// package without `"type": "module"` is not one of those. Naming the format in
// the load hook is what makes `.ts` behave here exactly as it does in the app.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const STUB_URL = 'rpsfish-arena:react-native';
const SOURCE_ROOT = pathToFileURL(new URL('../src/', import.meta.url).pathname);
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mts'];

export const resolve = async (specifier, context, next) => {
  if (specifier === 'react-native') return { shortCircuit: true, url: STUB_URL };

  if (specifier.startsWith('@/')) {
    return resolve(new URL(specifier.slice(2), SOURCE_ROOT).href, context, next);
  }

  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
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
  if (url === STUB_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export const Platform = { OS: "node" };',
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
