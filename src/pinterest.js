import { UserError } from './errors.js';
import { normalizePinUrl, BROWSER_HEADERS } from './urls.js';

const TIMEOUT = 15000;
const MAX_DEPTH = 60;
const VIDEO_EXT = /\.mp4(?:$|\?)/i;
const HLS_EXT = /\.m3u8(?:$|\?)/i;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)(?:$|\?)/i;
const PINIMG_MEDIA = /^https?:\/\/(?:[a-z0-9-]+\.)*pinimg\.com\//i;
const EXTERNAL_PROVIDERS = /^(?:https?:\/\/)?(?:www\.)?(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|dailymotion\.com|facebook\.com|fb\.watch)\//i;

export async function resolvePin(rawUrl) {
  const { url, id } = await normalizePinUrl(rawUrl);

  let pin = null;
  if (id) {
    pin = await fetchPinResource(id);
  }

  if (!pin) {
    const html = await fetchPinHtml(url);
    pin = pinFromHtml(html, id);
  }

  if (!pin) {
    throw new UserError('Pin not found — it may be private, deleted, or region-locked.', 404);
  }

  if (id && !collectVideoLists(pin).length && pin.story_pin_data_id) {
    const story = await fetchStoryPinResource(pin.story_pin_data_id);
    if (story) pin = { ...pin, story_pin_data: story };
  }

  const result = buildResult(pin, url);
  await ensureMp4(result);
  finalize(result);
  if (!result.media.length && !result.external) {
    throw new UserError('No downloadable media was found on this pin.', 422);
  }
  return result;
}

export async function ensureMp4(result) {
  const hasMp4 = result.media.some((item) => item.kind === 'video' && !item.hls);
  if (hasMp4) return;

  const hls = result.media.filter((item) => item.kind === 'video' && item.hls);
  if (!hls.length) return;

  const candidates = [...new Set(hls.flatMap((item) => deriveMp4Candidates(item.url)))].slice(0, 24);
  const working = await verifyCandidates(candidates);

  for (const url of working) {
    const label = qualityFromUrl(url) || 'MP4';
    if (result.media.some((item) => item.url === url || item.label === label)) continue;
    result.media.push({
      kind: 'video',
      url,
      rendition: 'DERIVED',
      label,
      ext: 'mp4',
      hls: false,
      derived: true,
    });
  }
}

export function finalize(result) {
  const hasMp4 = result.media.some((item) => item.kind === 'video' && !item.hls);
  if (hasMp4) result.media = result.media.filter((item) => !item.hls);

  result.media.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
    if (a.hls !== b.hls) return a.hls ? 1 : -1;
    return (b.height || 0) * (b.width || 0) - (a.height || 0) * (a.width || 0);
  });

  result.hasMp4 = hasMp4;
  result.type = hasMp4
    ? 'video'
    : result.external
    ? 'external'
    : result.media.some((item) => item.kind === 'image')
    ? 'image'
    : 'unknown';

  result.primary =
    result.media.find((item) => item.kind === 'video' && !item.hls) ||
    result.media.find((item) => item.kind === 'image') ||
    null;
}

export function deriveMp4Candidates(hlsUrl) {
  let url;
  try {
    url = new URL(hlsUrl);
  } catch {
    return [];
  }

  const match = url.pathname.match(/^(\/videos\/)([^/]+)\/(?:hls\d*|hlsv\d+|h265|h264)\/(.+?)\.m3u8$/i);
  if (!match) return [];

  const [, prefix, bucket, rest] = match;
  const buckets = [...new Set([bucket, 'iht', 'mc'])];
  const qualities = ['1080p', '720p', '480p', '360p', 'originals'];
  const out = [];
  for (const b of buckets) {
    for (const q of qualities) {
      out.push(`${url.origin}${prefix}${b}/${q}/${rest}.mp4`);
    }
  }
  return [...new Set(out)];
}

async function verifyCandidates(candidates) {
  const working = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < candidates.length) {
      const url = candidates[cursor++];
      if (await probeMedia(url)) working.push(url);
    }
  };

  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, worker));
  return working;
}

async function probeMedia(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 200 && res.status !== 206) return false;
    const type = res.headers.get('content-type') || '';
    return /video|octet-stream/i.test(type);
  } catch {
    return false;
  }
}

function qualityFromUrl(url) {
  const match = url.match(/\/(\d{3,4}p)\//i);
  return match ? match[1].toLowerCase() : null;
}

async function pinterestResource(name, payload, referer) {
  const endpoint =
    `https://www.pinterest.com/resource/${name}/get/?data=${encodeURIComponent(JSON.stringify(payload))}` +
    `&sourceUrl=${encodeURIComponent(referer)}`;
  const res = await fetch(endpoint, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept-Language': BROWSER_HEADERS['Accept-Language'],
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Pinterest-PWS-Handler': 'www/pin/[id].js',
      'X-Pinterest-AppState': 'active',
      Referer: `https://www.pinterest.com${referer}`,
      Origin: 'https://www.pinterest.com',
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name} responded with ${res.status}`);

  const json = await res.json().catch(() => null);
  const response = json && json.resource_response;
  if (!response) return null;
  if (response.error) {
    if (response.error.http_status === 404) return null;
    throw new Error(`${name} error: ${response.error.message || 'unknown'}`);
  }
  return response.data || null;
}

async function fetchPinResource(id) {
  try {
    return await pinterestResource(
      'PinResource',
      {
        options: { id, field_set_key: 'unauth_react_main_pin', fieldSetKey: 'unauth_react_main_pin', isPinPage: true },
        context: {},
      },
      `/pin/${id}/`,
    );
  } catch {
    return null;
  }
}

async function fetchStoryPinResource(id) {
  try {
    return await pinterestResource('StoryPinResource', { options: { id }, context: {} }, `/pin/${id}/`);
  } catch {
    return null;
  }
}

async function fetchPinHtml(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: BROWSER_HEADERS });
  } catch {
    throw new UserError('Could not load that pin from Pinterest. Please try again.', 502);
  }
  if (res.status === 404) return '';
  if (!res.ok) {
    throw new UserError(`Pinterest returned ${res.status} for that pin. Please try again later.`, 502);
  }
  return res.text();
}

function pinFromHtml(html, id) {
  if (!html) return null;

  const initialProps = readJsonScript(html, '__PWS_INITIAL_PROPS__') || readJsonScript(html, '__PWS_DATA__');
  if (initialProps) {
    const pin = findPinInState(initialProps, id);
    if (pin) return pin;
  }

  const scanned = pinFromRawScan(html);
  if (scanned) return scanned;
  return null;
}

function readJsonScript(html, id) {
  const pattern = new RegExp(`<script[^>]*id="${id}"[^>]*type="application/json"[^>]*>([\\s\\S]*?)<\\/script>`);
  const match = html.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function findPinInState(state, id) {
  const redux = state.initialReduxState || state;
  const pins = redux.pins;
  if (pins && typeof pins === 'object') {
    if (id && pins[id]) return pins[id];
    const candidate = Object.values(pins).find((pin) => pin && typeof pin === 'object' && (pin.videos || pin.images || pin.story_pin_data));
    if (candidate) return candidate;
  }

  const resource = redux.resources && redux.resources.PinResource;
  if (resource && typeof resource === 'object') {
    for (const entry of Object.values(resource)) {
      const data = entry && entry.data;
      if (data && typeof data === 'object' && (data.videos || data.images)) return data;
    }
  }
  return null;
}

function pinFromRawScan(html) {
  const flat = html.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
  const videos = [...new Set(flat.match(/https?:\/\/[^"'\\\s]+?\.m3u8(?:\?[^"'\\\s]*)?/gi) || [])];
  const mp4s = [...new Set(flat.match(/https?:\/\/[^"'\\\s]+?\.mp4(?:\?[^"'\\\s]*)?/gi) || [])];
  if (!mp4s.length && !videos.length) return null;

  const videoList = {};
  for (const url of mp4s) {
    const label = (url.match(/\/(\d{3,4}p)\//i) || [])[1];
    const key = label ? `V_${label.toUpperCase()}` : `V_${Object.keys(videoList).length}`;
    videoList[key] = { url };
  }
  for (const url of videos) {
    videoList[`V_HLS${Object.keys(videoList).length}`] = { url };
  }

  const title = (html.match(/<meta[^>]+(?:property|name)="og:title"[^>]+content="([^"]*)"/i) || [])[1];
  const image = (html.match(/<meta[^>]+(?:property|name)="og:image"[^>]+content="([^"]*)"/i) || [])[1];

  return {
    videos: { video_list: videoList },
    images: image ? { orig: { url: image } } : undefined,
    title,
  };
}

export function buildResult(pin, sourceUrl) {
  const media = [];
  const seen = new Set();

  const push = (item) => {
    if (!item.url || seen.has(item.url)) return;
    seen.add(item.url);
    media.push(item);
  };

  for (const list of collectVideoLists(pin)) {
    for (const [rendition, info] of Object.entries(list)) {
      const url = typeof info === 'string' ? info : info && info.url;
      if (!url) continue;
      const hls = HLS_EXT.test(url);
      push({
        kind: 'video',
        url: absolutize(url),
        rendition,
        label: labelFor(rendition, hls),
        width: info && info.width,
        height: info && info.height,
        duration: info && info.duration,
        thumbnail: (info && info.thumbnail) || undefined,
        ext: hls ? 'm3u8' : 'mp4',
        hls,
      });
    }
  }

  media.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
    if (a.hls !== b.hls) return a.hls ? 1 : -1;
    return (b.height || 0) * (b.width || 0) - (a.height || 0) * (a.width || 0);
  });

  const hasVideo = media.some((item) => item.kind === 'video' && !item.hls);
  const images = collectImages(pin);
  images.forEach((image, index) => {
    const hero = index === 0;
    push({
      kind: 'image',
      url: absolutize(image.url),
      label: hasVideo && hero ? 'Cover image' : images.length > 1 ? `Image ${index + 1}` : 'Image',
      width: image.width,
      height: image.height,
      ext: extFromUrl(image.url) || 'jpg',
      hls: false,
    });
  });

  const external = hasVideo ? null : findExternal(pin);
  const title = clean(pin.grid_title) || clean(pin.title) || clean(pin.seo_title) || clean(pin.description) || '';
  const description = clean(pin.description) || clean(pin.closeup_description) || clean(pin.seo_description) || '';
  const authorSource = pin.origin_pinner || pin.pinner || pin.native_creator || null;

  const id = pin.id || null;
  const canonical = id ? `https://www.pinterest.com/pin/${id}/` : sourceUrl;

  return {
    id,
    url: canonical,
    sourceUrl,
    type: hasVideo ? 'video' : external ? 'external' : images.length ? 'image' : 'unknown',
    title: title.slice(0, 300),
    description: description.slice(0, 800),
    author: authorSource
      ? {
          name: clean(authorSource.full_name) || clean(authorSource.first_name) || '',
          username: clean(authorSource.username) || '',
          avatar: absolutize(authorSource.image_small_url || authorSource.image_medium_url || ''),
          url: authorSource.username ? `https://www.pinterest.com/${authorSource.username}/` : '',
        }
      : null,
    thumbnail: absolutize((pin.images && pin.images.orig && pin.images.orig.url) || (media[0] && media[0].thumbnail) || ''),
    duration: media.find((item) => item.kind === 'video' && item.duration)?.duration || null,
    external,
    media,
  };
}

function collectVideoLists(root) {
  const found = [];
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'video_list' && value && typeof value === 'object' && !Array.isArray(value)) {
        found.push(value);
      } else {
        walk(value, depth + 1);
      }
    }
  };

  walk(root, 0);
  return found;
}

function collectImages(pin) {
  const images = [];
  const primary = bestImage(pin.images);
  if (primary) images.push(primary);

  if (!primary || images.length < 2) {
    const carousel = extractCarouselImages(pin.carousel_data || (pin.story_pin_data && pin.story_pin_data) || null);
    for (const url of carousel) {
      if (!images.some((image) => image.url === url)) images.push({ url });
    }
  }
  return images.slice(0, 30);
}

function bestImage(images) {
  if (!images || typeof images !== 'object') return null;
  if (images.orig && images.orig.url) {
    return { url: images.orig.url, width: images.orig.width, height: images.orig.height };
  }
  let best = null;
  for (const value of Object.values(images)) {
    if (!value || typeof value !== 'object' || !value.url || !IMAGE_EXT.test(value.url)) continue;
    const area = (value.width || 0) * (value.height || 0);
    if (!best || area > best.area) best = { url: value.url, width: value.width, height: value.height, area };
  }
  return best ? { url: best.url, width: best.width, height: best.height } : null;
}

function extractCarouselImages(root) {
  const urls = new Set();
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1));
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && PINIMG_MEDIA.test(value) && IMAGE_EXT.test(value) && !/\/30x30|\/60x60|\/75x75/.test(value)) {
        urls.add(value);
      } else {
        walk(value, depth + 1);
      }
    }
  };

  walk(root, 0);
  return [...urls];
}

function findExternal(pin) {
  const candidates = [
    pin.attribution && pin.attribution.url,
    pin.rich_metadata && pin.rich_metadata.url,
    pin.embed && pin.embed.src,
    pin.link,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const url = absolutize(candidate);
    if (EXTERNAL_PROVIDERS.test(url)) {
      const match = url.match(EXTERNAL_PROVIDERS);
      return { provider: providerName(match[1]), url };
    }
  }
  return null;
}

function providerName(host) {
  const map = {
    'youtube.com': 'YouTube',
    'youtu.be': 'YouTube',
    'vimeo.com': 'Vimeo',
    'tiktok.com': 'TikTok',
    'dailymotion.com': 'Dailymotion',
    'facebook.com': 'Facebook',
    'fb.watch': 'Facebook',
  };
  return map[host] || host;
}

function labelFor(rendition, hls) {
  const height = rendition.match(/V_(\d{3,4})P/i);
  if (height) return `${height[1]}p`;
  if (hls) return 'HLS (stream)';
  return rendition.replace(/^V_/, '').replace(/_/g, ' ').toLowerCase() || 'Video';
}

function extFromUrl(url) {
  const match = url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function absolutize(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}
