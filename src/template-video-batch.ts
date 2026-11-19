export type VideoTarget = { id: string; title: string; slug: string; episodes?: { id?: string }[] };
export function planVideoBatch(files: File[], templates: VideoTarget[], sources: { id: string; local: { template_video: string } }[] = []) {
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
    const source = sources.find(item => folder.endsWith(item.local.template_video.replace(/\/[^/]+$/, '')));
    const name = normalize(folder.split('/').pop()!.replace(/^\d+_/, ''));
    const matches = source ? templates.filter(t => t.slug === source.id) : templates.filter(t => normalize(t.title) === name || normalize(t.slug) === name);
    if (matches.length !== 1) throw new Error(`${folder} 匹配到 ${matches.length} 个模板，请核对模板名称`);
    const target = matches[0]!;
    if (seen.has(target.id)) throw new Error(`${target.title} 被多个目录重复匹配`);
    seen.add(target.id);
    return { target, input: group.input!, preview: group.preview };
  });
}
