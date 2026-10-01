// Vercel function for TopoMap: /api/resolve follows a Google Maps short link to
// its final URL — a browser page is not allowed to do that itself. Same contract
// as server.ps1.

export const config = { runtime: 'edge' };

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Only Google hosts may be fetched (checked on every redirect hop).
const GOOGLE_HOST = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|([a-z0-9-]+\.)*google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2}))$/;
const NUM = '(-?\\d{1,3}\\.\\d+)';
const URL_HAS_COORDS = new RegExp(`!3d${NUM}!4d${NUM}|@${NUM},${NUM}|[?&](?:q|query|ll)=${NUM},|/(?:search|place)/${NUM},`);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function decoded(url) {
  try { return decodeURIComponent(url); } catch { return url; }
}

function hintFromPage(body) {
  const pin = body.match(new RegExp(`!3d${NUM}!4d${NUM}`));
  if (pin) return { lat: +pin[1], lng: +pin[2] };
  // Initial camera as [[[distance, lng, lat]. Only trust it when zoomed in on a
  // place; a far camera is just a default view, not the linked place.
  const cam = body.match(new RegExp(`APP_INITIALIZATION_STATE=\\[\\[\\[([\\d.]+),${NUM},${NUM}\\]`));
  if (cam && +cam[1] <= 5000) return { lat: +cam[3], lng: +cam[2], approximate: true };
  return null;
}

async function resolveLink(link) {
  let current = link;
  for (let hop = 0; hop < 10; hop++) {
    const url = new URL(current);
    if (!/^https?:$/.test(url.protocol) || !GOOGLE_HOST.test(url.hostname)) {
      throw new Error('Not a Google Maps link');
    }
    // Stop as soon as the URL itself carries the coordinates.
    if (URL_HAS_COORDS.test(decoded(current))) return { finalUrl: current, hint: null };

    const res = await fetch(url.href, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, url).href;
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = (await res.text()).slice(0, 1500000);
    return { finalUrl: current, hint: hintFromPage(body) };
  }
  throw new Error('Too many redirects');
}

export default async function handler(request) {
  const link = new URL(request.url).searchParams.get('url');
  if (!link) return json({ error: 'missing url' }, 400);
  try {
    return json(await resolveLink(link));
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}
