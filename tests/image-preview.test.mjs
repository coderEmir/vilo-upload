import test from 'node:test';
import assert from 'node:assert/strict';
import {webpFallbackUrl} from '../src/image-preview.ts';
test('failed OSS WebP uses PNG decoder fallback and preserves other operations',()=>{
 const u = new URL(webpFallbackUrl('https://vilo.oss-ap-southeast-1.aliyuncs.com/a.webp?x-oss-process=image/resize,w_200/format,webp'));
 assert.equal(u.searchParams.get('x-oss-process'),'image/resize,w_200/format,png');
 assert.equal(webpFallbackUrl(u.href),undefined);
});
test('signed, external and non-WebP sources are left intact',()=>{
 for (const u of ['https://example.com/a.webp','https://vilo.oss-ap-southeast-1.aliyuncs.com/a.webp?Signature=x','https://vilo.oss-ap-southeast-1.aliyuncs.com/a.mp4']) assert.equal(webpFallbackUrl(u),undefined);
});
