/** Keep original/animated WebP first. OSS can decode a failed WebP for older clients. */
export function webpFallbackUrl(source: string): string | undefined {
  let url: URL;
  try { url = new URL(source); } catch { return; }
  if (!/\.webp$/i.test(url.pathname) || !/(^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(url.hostname)) return;
  // Changing signed query parameters invalidates the signature.
  if ([...url.searchParams.keys()].some(key => /signature|credential/i.test(key))) return;
  const process = url.searchParams.get('x-oss-process');
  if (process && !process.startsWith('image/')) return;
  const operations = (process || 'image').split('/').filter(part => !part.startsWith('format,'));
  operations.push('format,png');
  url.searchParams.set('x-oss-process', operations.join('/'));
  return url.href === source ? undefined : url.href;
}
