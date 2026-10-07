const form = document.getElementById('url-form');
const input = document.getElementById('url');
const submit = document.getElementById('submit');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');

let toastTimer = null;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) {
    showError('Paste a Pinterest pin link first.');
    return;
  }
  lookup(url);
});

input.addEventListener('paste', (event) => {
  const text = (event.clipboardData || window.clipboardData).getData('text');
  if (text) {
    event.preventDefault();
    input.value = text.trim();
    lookup(input.value);
  }
});

async function lookup(url) {
  setLoading(true);
  resultEl.hidden = true;
  resultEl.innerHTML = '';

  try {
    const response = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    render(data.pin);
  } catch (error) {
    showError(error.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
}

function setLoading(loading) {
  submit.disabled = loading;
  submit.textContent = loading ? 'Finding…' : 'Grab it';
  if (loading) {
    statusEl.hidden = false;
    statusEl.className = 'status loading';
    statusEl.innerHTML = '<span class="spinner"></span><span>Looking for media on this pin…</span>';
  } else if (statusEl.classList.contains('loading')) {
    statusEl.hidden = true;
  }
}

function showError(message) {
  statusEl.hidden = false;
  statusEl.className = 'status error';
  statusEl.textContent = message;
}

function render(pin) {
  statusEl.hidden = true;
  resultEl.hidden = false;
  resultEl.innerHTML = '';

  const preview = buildPreview(pin);
  if (preview) resultEl.append(preview);

  const meta = document.createElement('div');
  meta.className = 'meta';

  const typeLabel = { video: 'Video pin', image: 'Image pin', external: 'Embedded video', unknown: 'Pin' }[pin.type] || 'Pin';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = typeLabel;
  meta.append(badge);

  const title = document.createElement('h2');
  title.textContent = pin.title || 'Untitled pin';
  meta.append(title);

  if (pin.description) {
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = pin.description;
    meta.append(desc);
  }

  if (pin.author && (pin.author.name || pin.author.username)) {
    const author = document.createElement('div');
    author.className = 'author';

    if (pin.author.avatar) {
      const avatar = document.createElement('img');
      avatar.src = pin.author.avatar;
      avatar.alt = '';
      avatar.loading = 'lazy';
      avatar.onerror = () => avatar.remove();
      author.append(avatar);
    }

    const link = document.createElement('a');
    link.href = pin.author.url || pin.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = pin.author.name || `@${pin.author.username}`;
    author.append(link);

    const source = document.createElement('a');
    source.href = pin.url;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = 'View pin ↗';
    source.style.marginLeft = 'auto';
    author.append(source);

    meta.append(author);
  }

  resultEl.append(meta);

  if (pin.primary) {
    resultEl.append(buildDownloadBar(pin));
  }

  if (pin.external) {
    resultEl.append(buildExternal(pin));
  }

  if (pin.media && pin.media.length) {
    resultEl.append(buildMediaList(pin));
  }

  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildDownloadBar(pin) {
  const item = pin.primary;
  const wrap = document.createElement('div');
  wrap.className = 'download-bar';

  const isVideo = item.kind === 'video';
  const label = isVideo ? `Download MP4${item.label && item.label !== 'MP4' ? ` · ${item.label}` : ''}` : 'Download image';

  const save = document.createElement('a');
  save.className = 'btn primary big';
  save.href = downloadHref(pin, item);
  save.textContent = label;
  save.setAttribute('download', '');
  wrap.append(save);

  const copy = document.createElement('button');
  copy.className = 'btn ghost';
  copy.type = 'button';
  copy.textContent = 'Copy direct link';
  copy.addEventListener('click', () => copyLink(item.url));
  wrap.append(copy);

  if (item.width && item.height) {
    const dims = document.createElement('span');
    dims.className = 'hint';
    dims.textContent = `${item.width}×${item.height}`;
    wrap.append(dims);
  }

  return wrap;
}

function buildPreview(pin) {
  const video = (pin.media || []).find((item) => item.kind === 'video' && !item.hls);
  const preview = document.createElement('div');
  preview.className = 'preview';

  if (video) {
    const el = document.createElement('video');
    el.src = video.url;
    el.poster = pin.thumbnail || '';
    el.controls = true;
    el.playsInline = true;
    el.loop = true;
    el.muted = true;
    el.autoplay = true;
    preview.append(el);
  } else if (pin.thumbnail) {
    const el = document.createElement('img');
    el.src = pin.thumbnail;
    el.alt = pin.title || 'Pinterest pin';
    el.loading = 'lazy';
    preview.append(el);
  } else {
    return null;
  }

  return preview;
}

function buildExternal(pin) {
  const wrap = document.createElement('div');
  wrap.className = 'external';

  const text = document.createElement('p');
  text.textContent = `This pin embeds a ${pin.external.provider} video, which isn't hosted on Pinterest. Open it at the source to save it.`;
  wrap.append(text);

  const link = document.createElement('a');
  link.className = 'btn primary';
  link.href = pin.external.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `Open on ${pin.external.provider}`;
  wrap.append(link);

  return wrap;
}

function buildMediaList(pin) {
  const wrap = document.createElement('div');
  wrap.className = 'media';

  const head = document.createElement('div');
  head.className = 'media-head';
  head.innerHTML = '<span>All files</span><span>Save</span>';
  wrap.append(head);

  if (pin.type === 'video' && !pin.hasMp4) {
    const warn = document.createElement('div');
    warn.className = 'note warn';
    warn.textContent =
      'Pinterest only exposed a streaming playlist (HLS) for this pin, so no direct MP4 file was available. Try again in a moment, or open the stream link in a media player.';
    wrap.append(warn);
  }

  for (const item of pin.media) {
    wrap.append(buildMediaRow(pin, item));
  }
  return wrap;
}

function buildMediaRow(pin, item) {
  const row = document.createElement('div');
  row.className = 'media-row';

  const chip = document.createElement('span');
  chip.className = `chip ${item.kind === 'image' ? 'image' : ''} ${item.hls ? 'hls' : ''}`.trim();
  chip.textContent = item.label || item.kind;
  row.append(chip);

  const info = document.createElement('div');
  info.className = 'media-info';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = filenameFor(pin, item);
  info.append(name);

  const sub = document.createElement('div');
  sub.className = 'sub';
  const bits = [item.hls ? 'HLS playlist' : item.ext.toUpperCase()];
  if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
  if (item.duration) bits.push(formatDuration(item.duration));
  if (item.hls) bits.push('use a video player');
  if (item.derived) bits.push('extracted from stream');
  sub.textContent = bits.join(' · ');
  info.append(sub);

  row.append(info);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const save = document.createElement('a');
  save.className = 'btn primary';
  save.href = downloadHref(pin, item);
  save.textContent = 'Save';
  save.setAttribute('download', '');
  actions.append(save);

  const copy = document.createElement('button');
  copy.className = 'btn ghost';
  copy.type = 'button';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', () => copyLink(item.url));
  actions.append(copy);

  row.append(actions);
  return row;
}

function filenameFor(pin, item) {
  const base = (pin.title || `pinterest-${pin.id || 'pin'}`)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70)
    .trim();
  const safeBase = base || `pinterest-${pin.id || 'pin'}`;
  const label = (item.label || item.kind).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const suffix = label ? `-${label}` : '';
  return `${safeBase}${suffix}.${item.ext}`;
}

function downloadHref(pin, item) {
  const params = new URLSearchParams({
    src: item.url,
    name: filenameFor(pin, item),
  });
  return `/api/download?${params.toString()}`;
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('Direct link copied');
  } catch {
    toast('Copy failed — long-press the Save button');
  }
}

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
