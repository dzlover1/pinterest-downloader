import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { resolvePin } from './src/pinterest.js';
import { assertMediaUrl, sanitizeFilename, BROWSER_HEADERS } from './src/urls.js';
import { UserError } from './src/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use('/api', rateLimit());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', extensions: ['html'] }));

app.get('/api/resolve', async (req, res, next) => {
  try {
    const pin = await resolvePin(req.query.url);
    res.json({ ok: true, pin });
  } catch (error) {
    next(error);
  }
});

app.get('/api/download', async (req, res, next) => {
  try {
    const src = assertMediaUrl(req.query.src);
    const name = ensureExtension(sanitizeFilename(req.query.name), src);

    const upstream = await fetch(src, {
      signal: AbortSignal.timeout(60000),
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        Accept: '*/*',
        Referer: 'https://www.pinterest.com/',
      },
    });

    if (!upstream.ok || !upstream.body) {
      throw new UserError(`Pinterest returned ${upstream.status} for that file.`, 502);
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (contentType.includes('text/html')) {
      throw new UserError('Pinterest refused to serve that file. Please try again.', 502);
    }

    const length = upstream.headers.get('content-length');
    res.status(200);
    res.setHeader('Content-Type', contentType);
    if (length) res.setHeader('Content-Length', length);
    res.setHeader('Content-Disposition', contentDisposition(name));
    res.setHeader('Cache-Control', 'private, no-store');

    const stream = Readable.fromWeb(upstream.body);
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Not found.' });
});

app.use((error, req, res, _next) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = error instanceof UserError ? error.status : 500;
  if (status >= 500 && !(error instanceof UserError)) {
    console.error('[error]', error);
  }
  res.status(status).json({ ok: false, error: error.message || 'Something went wrong.' });
});

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\s]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function ensureExtension(name, src) {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const match = src.match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || src.match(/\/([a-z0-9]{2,5})(?:\?|$)/i);
  return match ? `${name}.${match[1].toLowerCase()}` : `${name}.mp4`;
}

function rateLimit(max = 60, windowMs = 60000) {
  const buckets = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.start > windowMs * 2) buckets.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.start + windowMs - now) / 1000)));
      res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });
      return;
    }
    next();
  };
}

app.listen(PORT, () => {
  console.log(`PinGrab running at http://localhost:${PORT}`);
});
