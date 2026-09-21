/**
 * Serves the dashboard's static assets.
 *
 * Read from disk once at startup and held in memory: the files are ~70 KB
 * total, the process is short-lived, and re-reading per request would be a
 * disk hit on the loopback path for no benefit.
 *
 * The assets are plain HTML/CSS/JS with no build step — the same property the
 * rest of the tool has. What you read in src/dashboard/assets is exactly what
 * the browser receives.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'assets');

export interface Asset {
  body: string;
  type: string;
}

function read(name: string, type: string): Asset {
  return { body: readFileSync(join(ASSETS, name), 'utf8'), type };
}

/**
 * The page is assembled here rather than shipped as a complete document, so
 * the provider marks can be inlined. They have to be: the page's own CSP
 * allows no external origin, and an <img> blocked by CSP renders nothing —
 * silently.
 *
 * TODO(cdn): serve the marks from a CDN instead of inlining. Two things have
 * to change together or the icons silently vanish:
 *   1. add the CDN origin to `img-src` in the page's Content-Security-Policy
 *      (src/proxy/server.ts),
 *   2. swap these reads for <img src> and drop the `currentColor` theming,
 *      since an external image cannot inherit the page's colour — the marks
 *      would need light/dark variants, or a filter.
 * Keep the local files as the offline fallback: this is a local tool and it
 * should not need the network to draw its own UI.
 */
function buildIndex(): Asset {
  const shell = read('index.html', 'text/html; charset=utf-8').body;
  const marks = {
    claude: readFileSync(join(ASSETS, 'claude.svg'), 'utf8').trim(),
    codex: readFileSync(join(ASSETS, 'chatgpt.svg'), 'utf8').trim(),
  };

  return {
    type: 'text/html; charset=utf-8',
    body:
      '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      shell.replace('<script src="app.js"></script>', '') +
      `\n<script>window.__MARKS__ = ${JSON.stringify(marks)};</script>\n` +
      '<script src="/app.js"></script>\n</body>\n</html>\n',
  };
}

let cache: Record<string, Asset> | null = null;

/** Every asset the dashboard serves, keyed by request path. */
export function assets(): Record<string, Asset> {
  if (cache) return cache;
  cache = {
    '/': buildIndex(),
    '/stats': buildIndex(),
    '/app.js': read('app.js', 'text/javascript; charset=utf-8'),
    '/style.css': read('style.css', 'text/css; charset=utf-8'),
  };
  return cache;
}
