#!/usr/bin/env node
// ── stamp-version.mjs ─────────────────────────────────────────────────────────
// Stamp a per-deploy version onto every ES-module URL so iOS — which caches
// module scripts aggressively, especially as a home-screen web app — is forced
// to refetch on each deploy. Run as a build step BEFORE Caddy serves the files.
//
// What it touches:
//   • index.html  — the entry <script src="js/main.js">
//   • js/*.js      — every relative `.js` import inside each module
// Each gets `?v=<VERSION>`. Re-running is safe: existing stamps are replaced,
// not stacked.
//
// VERSION comes from Railway's commit SHA when available (so it changes exactly
// once per deploy), falling back to a timestamp for local runs.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);

const ROOT  = process.cwd();
const JS_DIR = join(ROOT, 'js');
const INDEX  = join(ROOT, 'index.html');

// matches:  from './x.js'   |   import './x.js'   (', optional old ?…, same ")
const IMPORT_RE = /\b(from|import)(\s+)(['"])(\.{1,2}\/[^'"?]+\.js)(?:\?[^'"]*)?\3/g;
const stampImports = src =>
  src.replace(IMPORT_RE, (_m, kw, sp, q, path) => `${kw}${sp}${q}${path}?v=${VERSION}${q}`);

if (existsSync(JS_DIR)) {
  for (const name of readdirSync(JS_DIR)) {
    if (!name.endsWith('.js')) continue;
    const p = join(JS_DIR, name);
    writeFileSync(p, stampImports(readFileSync(p, 'utf8')));
  }
}

if (existsSync(INDEX)) {
  const html = readFileSync(INDEX, 'utf8').replace(
    /(<script[^>]*\bsrc=")(js\/main\.js)(?:\?[^"]*)?(")/,
    (_m, pre, path, post) => `${pre}${path}?v=${VERSION}${post}`,
  );
  writeFileSync(INDEX, html);
}

console.log(`stamped version v=${VERSION}`);
