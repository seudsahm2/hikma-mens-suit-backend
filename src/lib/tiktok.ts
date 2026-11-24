/**
 * TikTok links: the owner pastes whatever the TikTok app gives her (often a short vm.tiktok.com link).
 * We store the full link and play it with TikTok's official embed player, using the numeric video id.
 */
const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;

export function tikTokVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/video\/(\d{8,25})/) ?? url.match(/[?&](?:item_id|share_item_id)=(\d{8,25})/);
  return m ? m[1]! : null;
}

/** Follows short-link redirects (vm./vt.tiktok.com, tiktok.com/t/…) to the full video link. Never throws. */
export async function normalizeTikTokUrl(input: string | null | undefined): Promise<string | null> {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input.trim();
  }
  if (!TIKTOK_HOST.test(url.hostname) || tikTokVideoId(url.href)) return url.href;
  let current = url.href;
  for (let hop = 0; hop < 4; hop++) {
    try {
      const res = await fetch(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const next = res.headers.get('location');
      if (!next) break;
      current = new URL(next, current).href;
      if (tikTokVideoId(current)) {
        const clean = new URL(current);
        return `${clean.origin}${clean.pathname}`;
      }
    } catch {
      break;
    }
  }
  return url.href;
}
