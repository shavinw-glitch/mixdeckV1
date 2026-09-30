/* =============================================================================
   Wavefy — artwork lookup proxy (Supabase Edge Function)

   Why this exists
   ---------------
   Apple's iTunes Search API answers a *mobile* User-Agent with:

     301 Moved Permanently
     Location: musics://mzstoreservices-st.itunes.apple.com/search?...

   `musics://` is an iOS app deep-link scheme, so a browser cannot follow it and
   the request dies. User-Agent is a forbidden header name, which means client
   JavaScript fundamentally cannot mask it — a phone in a mobile browser has no
   direct route to this API at all. (Verified: 12/12 mobile-UA requests redirect,
   12/12 desktop-UA requests return JSON.)

   So the lookup has to happen server-side. This function mirrors what
   /api/artwork does in server.js, and gives the app a route that works with the
   user's PC switched off.

   Deploy
   ------
     supabase functions deploy artwork --project-ref nqyfpdkvsxekqhysmkgr

   Requires the Supabase CLI plus an access token (`supabase login`, or the
   SUPABASE_ACCESS_TOKEN env var). The app's anon key cannot deploy functions.
   No secrets are needed by this function — it only calls a public API.
   ============================================================================= */

/* Identify as a desktop client so Apple serves JSON instead of the deep link. */
const LOOKUP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

interface ItunesResult {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(req.url);
  const title = (url.searchParams.get('title') || '').trim();
  const artist = (url.searchParams.get('artist') || '').trim();
  const album = (url.searchParams.get('album') || '').trim();
  const term = (url.searchParams.get('term') || '').trim()
    || [title, artist, album].filter(Boolean).join(' ');

  if (!term) return json({ error: 'Missing track title' }, 400);

  const params = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '25' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://itunes.apple.com/search?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': LOOKUP_UA },
      signal: controller.signal,
    });
    if (!response.ok) return json({ error: `iTunes responded ${response.status}` }, 502);

    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? (data.results as ItunesResult[])
          .filter((r) => r && r.artworkUrl100)
          .map((r) => ({
            trackName: r.trackName,
            artistName: r.artistName,
            collectionName: r.collectionName,
            artworkUrl: String(r.artworkUrl100).replace(/100x100bb\./, '600x600bb.'),
          }))
      : [];

    // Covers for a given recording do not change — let the CDN hold them.
    return json(results, results.length ? 200 : 404, {
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    });
  } catch {
    return json({ error: 'Artwork lookup failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
});
