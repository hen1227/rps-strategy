// Install `loader.mjs` for a `node --import ./scripts/register.mjs …` run.
//
// The older `--loader` flag prints an experimental warning on every start;
// registering the hooks explicitly does the same job quietly.

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./loader.mjs', pathToFileURL(import.meta.filename));

// Metro turns `require('../../assets/pieces/red_rock.png')` into an opaque
// handle the image loader understands. Node has neither the handle nor
// `require` at all, so the appearance catalogues — which are just lists of
// them — could not be imported by a test that only wanted to count them.
//
// A global rather than something the loader injects per file, so no line
// numbers move and nothing in `src/` has to know this exists. The handle is the
// asset's own path, which is stable, comparable, and obviously not a real image
// if one ever escapes into an assertion.
globalThis.require ??= (specifier) => `asset:${specifier}`;
