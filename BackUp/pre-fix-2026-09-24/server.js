const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST || '0.0.0.0';
const musicDir = path.join(root, 'public-music');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const uploadToken = process.env.UPLOAD_TOKEN || '';
// One shared AudD key for ALL users, so song recognition works out of the box
// without every user bringing their own. The client carries the same key and
// calls AudD directly (see wavefy-core.js), which is why recognition keeps
// working with no server at all; /api/identify stays as a fallback for
// networks that block the browser's cross-origin call.
//
// NOTE: a token shipped in the repo is public and shared, so it will be rate
// limited and can be exhausted by anyone running this app. Set AUDD_TOKEN in
// the environment to use your own account instead; that always wins.
const BUILTIN_AUDD_TOKEN = '7b523b16dda42f0e79c49c3f0c4e52ac';
const auddToken = process.env.AUDD_TOKEN || BUILTIN_AUDD_TOKEN;
const AUDD_ENDPOINT = 'https://api.audd.io/';
fs.mkdirSync(musicDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};
const audioExtensions = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus']);

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(body);
}
function safeName(value) {
  return path.basename(String(value || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
}
function readRequest(request, limit = MAX_UPLOAD_BYTES + 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error('Upload is too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  while (start <= buffer.length) {
    const index = buffer.indexOf(delimiter, start);
    if (index < 0) { parts.push(buffer.subarray(start)); break; }
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
  }
  return parts;
}
function parseMultipart(buffer, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Object.assign(new Error('Missing multipart boundary'), { statusCode: 400 });
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = {};
  for (const rawPart of splitBuffer(buffer, boundary)) {
    let part = rawPart;
    if (part.length < 8 || part.equals(Buffer.from('--\r\n')) || part.equals(Buffer.from('--'))) continue;
    if (part.subarray(0, 2).equals(Buffer.from('\r\n'))) part = part.subarray(2);
    if (part.subarray(-2).equals(Buffer.from('\r\n'))) part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString('utf8');
    const content = part.subarray(headerEnd + 4);
    const disposition = headers.match(/content-disposition:\s*form-data;\s*([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    if (!name) continue;
    if (filename) files[name] = { filename: safeName(filename), content };
    else fields[name] = content.toString('utf8');
  }
  return { fields, files };
}
function publicTrackFromMeta(meta, id, extension) {
  return {
    id,
    name: meta.name || `shared${extension}`,
    title: meta.title || meta.name || 'Shared track',
    artist: meta.artist || 'Unknown artist',
    albumArtist: meta.albumArtist || meta.artist || 'Unknown artist',
    album: meta.album || '',
    genre: meta.genre || '',
    year: Number(meta.year) || 0,
    composer: meta.composer || '',
    trackNumber: Number(meta.trackNumber) || 0,
    discNumber: Number(meta.discNumber) || 0,
    bpm: Number(meta.bpm) || 0,
    duration: Number(meta.duration) || 0,
    artwork: null,
    lyrics: meta.lyrics || '',
    syncedLyrics: Array.isArray(meta.syncedLyrics) ? meta.syncedLyrics : null,
    lyricsSource: meta.lyricsSource || '',
    isPublic: true,
    downloaded: false,
    publicUrl: `/media/${id}${extension}`,
    uploadedAt: Number(meta.uploadedAt) || Date.now(),
  };
}
function listPublicTracks() {
  return fs.readdirSync(musicDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try { return JSON.parse(fs.readFileSync(path.join(musicDir, name), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
}
/* Apple answers a mobile User-Agent with a 301 to a `musics://` deep link that
   fetch() cannot follow, so every server-side lookup identifies as a desktop
   client. This is what makes artwork lookups work from a phone. */
const LOOKUP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const result = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': LOOKUP_UA },
      signal: controller.signal,
    });
    if (!result.ok) return null;
    return result.json();
  } finally {
    clearTimeout(timer);
  }
}
async function handleLyrics(request, response, searchParams) {
  const title = String(searchParams.get('track_name') || '').trim();
  const artist = String(searchParams.get('artist_name') || '').trim();
  const album = String(searchParams.get('album_name') || '').trim();
  if (!title) return json(response, 400, { error: 'Missing track title' });
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', album);
  let result = await fetchJson(`https://lrclib.net/api/get?${params}`);
  if (Array.isArray(result) && !result.length) result = null;
  if (!result) {
    const search = new URLSearchParams({ q: artist ? `${title} ${artist}` : title });
    result = await fetchJson(`https://lrclib.net/api/search?${search}`);
    if (Array.isArray(result) && !result.length) result = null;
  }
  if (!result && artist) {
    result = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  }
  if (!result) return json(response, 404, { error: 'Lyrics not found' });
  return json(response, 200, result);
}
async function handleArtwork(request, response, searchParams) {
  const title = String(searchParams.get('title') || '').trim();
  const artist = String(searchParams.get('artist') || '').trim();
  const album = String(searchParams.get('album') || '').trim();
  if (!title && !artist) return json(response, 400, { error: 'Missing track title' });
  const term = [title, artist, album].filter(Boolean).join(' ');
  const params = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '25' });
  const data = await fetchJson(`https://itunes.apple.com/search?${params}`);
  const results = Array.isArray(data && data.results)
    ? data.results.filter(r => r && r.artworkUrl100).map(r => ({
        trackName: r.trackName,
        artistName: r.artistName,
        collectionName: r.collectionName,
        artworkUrl: String(r.artworkUrl100).replace(/100x100bb\./, '600x600bb.'),
      }))
    : [];
  if (!results.length) return json(response, 404, { error: 'Artwork not found' });
  return json(response, 200, results);
}
/* Artist portraits for the Library's artist row. Deezer is the one keyless
   source that returns a real press photo of a singer or band (iTunes' artist
   endpoint carries no artwork at all), and it sends no CORS headers — so the
   lookup is proxied here and cached, meaning one upstream request per artist
   every few hours however often the row re-renders. */
const DEEZER_ARTIST_URL = 'https://api.deezer.com/search/artist';
const ARTIST_IMAGE_TTL_MS = 6 * 60 * 60 * 1000;
/* A miss is cached too, just briefly: it stops a re-rendering artist row from
   hammering Deezer, without hiding an artist behind a stale 404 all day. */
const ARTIST_IMAGE_MISS_TTL_MS = 30 * 60 * 1000;
const artistImageCache = new Map();
function artistKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
async function handleArtistImage(request, response, searchParams) {
  const name = String(searchParams.get('name') || '').trim();
  if (!name) return json(response, 400, { error: 'Missing artist name' });
  const key = artistKey(name);
  const cached = artistImageCache.get(key);
  if (cached && Date.now() - cached.at < (cached.image ? ARTIST_IMAGE_TTL_MS : ARTIST_IMAGE_MISS_TTL_MS)) {
    if (!cached.image) return json(response, 404, { error: 'Artist image not found' });
    return json(response, 200, { name: cached.name, image: cached.image, source: 'deezer' });
  }
  const params = new URLSearchParams({ q: name, limit: '12' });
  const data = await fetchJson(`${DEEZER_ARTIST_URL}?${params}`);
  const items = (data && Array.isArray(data.data) ? data.data : [])
    .filter(item => item && item.name && (item.picture_big || item.picture_xl));
  // An exact name match wins; otherwise stay inside the related results and take
  // the best-known act, so a search for "Coldplay" cannot land on a tribute band
  // just because it sorted first.
  const exact = items.find(item => artistKey(item.name) === key);
  const related = items.filter(item => {
    const other = artistKey(item.name);
    return other && (other.includes(key) || key.includes(other));
  });
  const pool = exact ? [exact] : (related.length ? related : items);
  const best = pool.slice().sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0] || null;
  if (!best) {
    artistImageCache.set(key, { at: Date.now(), name: '', image: '' });
    return json(response, 404, { error: 'Artist image not found' });
  }
  const image = String(best.picture_big || best.picture_xl);
  artistImageCache.set(key, { at: Date.now(), name: best.name, image });
  return json(response, 200, { name: best.name, image, source: 'deezer' });
}
async function handleIdentify(request, response) {
  if (!auddToken) return json(response, 503, { error: 'AI recognition is not configured on this server' });
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return json(response, 415, { error: 'Use multipart/form-data' });
  try {
    const body = await readRequest(request, 12 * 1024 * 1024);
    const { fields, files } = parseMultipart(body, contentType);
    const file = files.file || files.audio;
    if (!file || !file.content.length) return json(response, 400, { error: 'Send an audio clip to identify' });
    const form = new FormData();
    form.append('api_token', auddToken);
    const extension = path.extname(file.filename).toLowerCase();
    form.append('file', new Blob([file.content], { type: mimeTypes[extension] || 'audio/mpeg' }), file.filename);
    if (fields.return) form.append('return', String(fields.return));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const upstream = await fetch(AUDD_ENDPOINT, { method: 'POST', body: form, signal: controller.signal });
      const data = await upstream.json().catch(() => null);
      if (!data) return json(response, 502, { error: 'AudD returned an unreadable response' });
      return json(response, 200, data);
    } finally { clearTimeout(timer); }
  } catch (error) {
    return json(response, 500, { error: 'Could not reach AudD — try again' });
  }
}
async function handleUpload(request, response) {
  if (uploadToken && request.headers['x-upload-token'] !== uploadToken) return json(response, 401, { error: 'Invalid upload token' });
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return json(response, 415, { error: 'Use multipart/form-data' });
  try {
    const body = await readRequest(request);
    const { fields, files } = parseMultipart(body, contentType);
    const file = files.audio;
    if (!file || !file.content.length) return json(response, 400, { error: 'Choose an audio file' });
    if (file.content.length > MAX_UPLOAD_BYTES) return json(response, 413, { error: 'Maximum upload size is 100 MB' });
    const extension = path.extname(file.filename).toLowerCase();
    if (!audioExtensions.has(extension)) return json(response, 415, { error: 'Unsupported audio format' });
    let meta = {};
    try { meta = JSON.parse(fields.metadata || '{}'); } catch { return json(response, 400, { error: 'Invalid track metadata' }); }
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const track = publicTrackFromMeta({ ...meta, name: file.filename }, id, extension);
    fs.writeFileSync(path.join(musicDir, `${id}${extension}`), file.content);
    fs.writeFileSync(path.join(musicDir, `${id}.json`), JSON.stringify(track, null, 2));
    return json(response, 201, track);
  } catch (error) {
    return json(response, error.statusCode || 500, { error: error.message || 'Upload failed' });
  }
}
function serveMedia(request, response, pathname) {
  const name = safeName(pathname.replace(/^\/media\//, ''));
  if (!name || name.includes('..')) return response.end('Not found');
  const filePath = path.join(musicDir, name);
  if (!fs.existsSync(filePath) || !audioExtensions.has(path.extname(filePath).toLowerCase())) {
    response.writeHead(404); return response.end('Not found');
  }
  const stat = fs.statSync(filePath);
  const type = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    return fs.createReadStream(filePath).pipe(response);
  }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) { response.writeHead(416); return response.end(); }
  const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 1));
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return response.end(); }
  response.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });
  return fs.createReadStream(filePath, { start, end }).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const requestedPath = decodeURIComponent(request.url.split('?')[0]);
  if (request.method === 'OPTIONS' && requestedPath.startsWith('/api/')) {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',    'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Token' });
    return response.end();
  }
  if (request.method === 'GET' && requestedPath === '/api/public-tracks') return json(response, 200, listPublicTracks());
  if (request.method === 'GET' && requestedPath === '/api/lyrics') return handleLyrics(request, response, new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams);
  if (request.method === 'GET' && requestedPath === '/api/artwork') return handleArtwork(request, response, new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams);
  if (request.method === 'GET' && requestedPath === '/api/artist-image') return handleArtistImage(request, response, new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams);
  if (request.method === 'GET' && requestedPath === '/api/health') return json(response, 200, { ok: true, app: 'Wavefy', tracks: listPublicTracks().length });
  if (request.method === 'GET' && requestedPath === '/api/identify-status') return json(response, 200, { enabled: Boolean(auddToken) });
  if (request.method === 'POST' && requestedPath === '/api/identify') return handleIdentify(request, response);
  if (request.method === 'POST' && requestedPath === '/api/upload') return handleUpload(request, response);
  if (request.method === 'GET' && requestedPath.startsWith('/media/')) return serveMedia(request, response, requestedPath);

  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403); return response.end('Forbidden');
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      return response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
    const extension = path.extname(filePath).toLowerCase();
    // The shell must never come out of a browser or service-worker cache:
    // index.html and the app's JS change with every edit, and one stale copy
    // pins the phone to an old build no matter what the code does now — which
    // is what makes a fix look like it "didn't work". Icons and the vendored
    // parser can be cached briefly.
    const isShell = extension === '.html' || extension === '.js' || extension === '.css';
    response.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': isShell ? 'no-store' : 'public, max-age=3600',
    });
    response.end(content);
  });
});

server.listen(port, host, () => {
  console.log(`Mixdeck is running at http://localhost:${port}`);
  console.log('On your iPhone, use your PC IPv4 address from ipconfig instead of localhost.');
  console.log(`Shared uploads are stored in ${musicDir}`);
});
