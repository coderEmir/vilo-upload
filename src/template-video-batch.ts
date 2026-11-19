import { polloVideoIndex } from './pollo-video-index.ts';
export type VideoTarget = { id: string; title: string; slug: string; episodes?: { id?: string }[] };
export function planVideoBatch(files: File[], templates: VideoTarget[], sources: { id: string; title?: string; local: { template_video: string } }[] = []) {
  const normalize = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const groups = new Map<string, { input?: File; preview?: File }>();
  for (const file of files) {
    const path = (file.webkitRelativePath || file.name).split('/');
    const name = path.pop()!.toLowerCase();
    if (!['template_video.mp4', 'result_video.mp4'].includes(name)) continue;
    const folder = path.join('/');
    const group = groups.get(folder) || {};
    const key = name === 'template_video.mp4' ? 'input' : 'preview';
    if (group[key]) throw new Error(`重复视频：${folder}/${name}`);
    group[key] = file; groups.set(folder, group);
  }
  if (!groups.size) throw new Error('目录中没有 template_video.mp4 / result_video.mp4');
  const seen = new Set<string>();
  return [...groups].map(([folder, group]) => {
    if (!group.input?.size) throw new Error(`${folder} 缺少非空 template_video.mp4`);
    if (group.preview && !group.preview.size) throw new Error(`${folder} result_video.mp4 为空`);
    const basename = folder.split('/').pop()!;
    const key = (name: string) => normalize(name.normalize('NFKC').replace(/^\d+[_．.-]+/, ''));
    // Directory selection can start at the root, assets, or a single template.
    // Match the leaf folder, not an absolute/path suffix that depends on that choice.
    const supplied = sources.filter(item => normalize(item.local.template_video.replace(/\\/g, '/').split('/').at(-2) || '') === normalize(basename));
    if (supplied.length > 1) throw new Error(`${folder} 清单中存在重复目录`);
    const source = supplied[0] || polloVideoIndex.find(item => normalize(item.folder) === normalize(basename));
    const identityMatches = source ? templates.filter(t => t.slug === source.id || t.id === source.id) : [];
    const names = new Set([key(basename), ...(source?.title ? [key(source.title)] : [])]);
    const matches = identityMatches.length ? identityMatches : templates.filter(t => names.has(key(t.title)) || names.has(key(t.slug)));
    if (matches.length !== 1) throw new Error(`${folder} 匹配到 ${matches.length} 个模板${source ? `（原始标识：${source.id}）` : ''}，请核对模板唯一标识或名称`);
    const target = matches[0]!;
    if (seen.has(target.id)) throw new Error(`${target.title} 被多个目录重复匹配`);
    seen.add(target.id);
    return { target, input: group.input!, preview: group.preview };
  });
}
