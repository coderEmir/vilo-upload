export type BulkStatus = 'DRAFT' | 'PUBLISHED';
type Target = { id: string; title: string; publishedAt: string | null };
type Send = (path: string, init: RequestInit) => Promise<unknown>;

export async function updateTemplateStatuses(targets: Target[], status: BulkStatus, send: Send) {
  const succeeded: Array<{ id: string; status: BulkStatus; publishedAt: string | null }> = [];
  const failed: Array<{ id: string; title: string; message: string }> = [];
  const timestamp = new Date().toISOString();
  for (const item of targets) {
    const publishedAt = status === 'PUBLISHED' ? item.publishedAt || timestamp : item.publishedAt;
    try {
      await send(`/templates/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...(status === 'PUBLISHED' && !item.publishedAt ? { publishedAt } : {}) }),
      });
      succeeded.push({ id: item.id, status, publishedAt });
    } catch (error) {
      failed.push({ id: item.id, title: item.title, message: error instanceof Error ? error.message : '状态修改失败' });
    }
  }
  return { succeeded, failed };
}
