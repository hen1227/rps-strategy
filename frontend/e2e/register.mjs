// Install `loader.mjs` after `scripts/register.mjs`: `node --import
// ./scripts/register.mjs --import ./e2e/register.mjs …`. The hooks chain, and
// these run first.

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
