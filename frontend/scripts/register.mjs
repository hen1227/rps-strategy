// Install `loader.mjs` for a `node --import ./scripts/register.mjs …` run.
//
// The older `--loader` flag prints an experimental warning on every start;
// registering the hooks explicitly does the same job quietly.

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./loader.mjs', pathToFileURL(import.meta.filename));
