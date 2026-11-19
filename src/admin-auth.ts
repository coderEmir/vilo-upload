import { readApiResponse } from './api-response.ts';

export type AdminKeyStatus = 'idle' | 'checking' | 'valid' | 'invalid';

export function normalizeAdminKey(value: string): string {
  return value.trim();
}

async function verifyService(baseUrl: string, path: string, key: string, requiredArrays: string[]): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-template-admin-key': key },
  });
  const payload = await response.clone().json().catch(() => null);
  if (payload?.error?.code === 'TEMPLATE_ADMIN_KEY_NOT_CONFIGURED') {
    throw new Error('后端未配置 TEMPLATE_ADMIN_API_KEY，请配置后重启两个模板服务');
  }
  const verified = await readApiResponse(response, '密钥验证失败');
  if (!requiredArrays.every(field => Array.isArray(verified[field]))) {
    throw new Error('密钥验证接口响应无效，请检查 API 代理配置和后端服务版本');
  }
}

export async function verifyAdminKey(
  templateApiBase: string,
  remixApiBase: string,
  key: string,
): Promise<void> {
  await Promise.all([
    verifyService(templateApiBase, '/templates', key, ['templates', 'models']),
    verifyService(remixApiBase, '/template-remix/config', key, ['models']),
  ]);
}
