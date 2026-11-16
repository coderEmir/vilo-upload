/** Reject SPA fallback pages and empty responses before callers read API fields. */
export async function readApiResponse(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `${fallbackMessage} (${response.status})`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('接口未返回有效 JSON 对象，请检查 API 地址及 /template-api、/remix-api 代理配置和后端服务状态');
  }
  return payload;
}
