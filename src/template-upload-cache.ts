import { uploadTemplateFile } from './template-media.ts';

// Successful uploads survive a failed import and a browser refresh. Never cache failures.
export function createTemplateUploader(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const pending = new Map<string, Promise<string>>();
  return async (file: File, apiBase: string, adminKey: string, send: typeof fetch = fetch): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const key = `template-asset:v1:${apiBase}:${file.type}:${hash}`;
    let cached: string | null = null;
    try { cached = storage?.getItem(key) ?? null; } catch { /* Server deduplication remains available. */ }
    if (cached && /^https?:\/\//i.test(cached)) return cached;
    const existing = pending.get(key);
    if (existing) return existing;
    const task = uploadTemplateFile(file, apiBase, adminKey, send).then(url => {
      try { storage?.setItem(key, url); } catch { /* Keep the successful in-memory result. */ }
      return url;
    }).catch(error => { pending.delete(key); throw error; });
    pending.set(key, task);
    return task;
  };
}
