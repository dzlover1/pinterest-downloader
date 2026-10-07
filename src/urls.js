import { UserError } from './errors.js';

const PINTEREST_HOST = /^(?:[a-z0-9-]+\.)*pinterest\.[a-z]{2,3}(?:\.[a-z]{2,4})?$/i;
const SHORTENER_HOSTS = new Set(['pin.it', 'www.pin.it']);
const MEDIA_HOST = /^(?:[a-z0-9-]+\.)*pinimg\.com$/i;
const PIN_PATH = /^\/(?:pin|idea)\//;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export function isPinterestHost(hostname) {
  return PINTEREST_HOST.test(hostname);
}

export function extractPinId(url) {
  const match = url.pathname.match(/\/(?:pin|idea)\/(?:.*--)?(\d{6,})\/?$/);
  return match ? match[1] : null;
}

export async function normalizePinUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new UserError('Paste a Pinterest link first.', 400);
  }

  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError("That doesn't look like a valid URL.", 400);
  }

  const isShortener = SHORTENER_HOSTS.has(url.hostname.toLowerCase());
  if (!isPinterestHost(url.hostname) && !isShortener) {
    throw new UserError('Only Pinterest links are supported.', 400);
  }

  if (isShortener) {
    url = await followRedirect(url);
  }

  if (!PIN_PATH.test(url.pathname)) {
    throw new UserError('Paste a link to a specific pin — it should contain /pin/ or /idea/.', 400);
  }

  url.search = '';
  url.hash = '';
  return { url: url.toString(), id: extractPinId(url) };
}

async function followRedirect(url) {
  let res;
  try {
    res = await fetch(url.toString(), {
      redirect: 'follow',
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new UserError('Could not reach Pinterest. Please try again.', 502);
  }

  let final;
  try {
    final = new URL(res.url);
  } catch {
    throw new UserError('That link does not point to a Pinterest pin.', 400);
  }

  if (!isPinterestHost(final.hostname) || !PIN_PATH.test(final.pathname)) {
    throw new UserError('That link does not point to a Pinterest pin.', 400);
  }
  return final;
}

export function assertMediaUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new UserError('Invalid file link.', 400);
  }

  if (url.protocol !== 'https:') {
    throw new UserError('Invalid file link.', 400);
  }
  if (!MEDIA_HOST.test(url.hostname)) {
    throw new UserError('Only Pinterest media files can be downloaded through this server.', 400);
  }
  return url.toString();
}

export function sanitizeFilename(input, fallback = 'pinterest-media') {
  let name = String(input || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 90)
    .trim();

  if (!name) name = fallback;
  return name;
}

export { BROWSER_HEADERS };
