import test from 'node:test';
import assert from 'node:assert/strict';
import { planVideoBatch } from '../src/template-video-batch.ts';
const file = path => { const f = new File(['video'], path.split('/').pop()); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f; };
const templates = [{id:'1',slug:'source-1',title:'Silly Face Dance',episodes:[{id:'ep1'}]}];
test('matches original numbered folder and separates input from result', () => {
 const files = ['template_video.mp4','result_video.mp4','preview.webp'].map(n=>file('root/assets/01_Silly_Face_Dance/'+n));
 const [job] = planVideoBatch(files,templates);
 assert.equal(job.target.id,'1'); assert.equal(job.input.name,'template_video.mp4'); assert.equal(job.preview.name,'result_video.mp4');
});
test('rejects missing videos and ambiguous or duplicate matches before uploads', () => {
 const pair = ['template_video.mp4','result_video.mp4'].map(n=>file('root/01_Silly_Face_Dance/'+n));
 assert.equal(planVideoBatch(pair.slice(0,1),templates)[0].preview, undefined);
 assert.throws(()=>planVideoBatch(pair.slice(1),templates),/缺少/);
 assert.throws(()=>planVideoBatch(pair,[...templates,{...templates[0],id:'2'}]),/2 个/);
 assert.throws(()=>planVideoBatch([...pair,...pair],templates),/重复视频/);
 assert.throws(()=>planVideoBatch(pair,[]),/0 个/);
});
test('manifest IDs disambiguate repeated titles and numeric titles remain intact', () => {
 const targets = [{id:'a',slug:'a',title:'24 Car',episodes:[{id:'ea'}]}, {id:'b',slug:'b',title:'24 Car',episodes:[{id:'eb'}]}];
 const sources = targets.map((t,i)=>({id:t.slug,local:{template_video:`assets/0${i+1}_24_Car/template_video.mp4`}}));
 const files = sources.flatMap(s=>['template_video.mp4','result_video.mp4'].map(n=>file('root/'+s.local.template_video.replace('template_video.mp4',n))));
 assert.deepEqual(planVideoBatch(files,targets,sources).map(j=>j.target.id),['a','b']);
 assert.equal(planVideoBatch(files.slice(0,2),targets.slice(0,1))[0].target.id,'a');
});

test('video templates need no episodes and result video is optional', () => {
 const [job] = planVideoBatch([file('root/01_Test/template_video.mp4')], [{id:'t',slug:'t',title:'Test'}]);
 assert.equal(job.target.id,'t'); assert.equal(job.preview,undefined);
});
test('original single folder matches source ID even after template title changes, without manifest',()=>{
 const [job]=planVideoBatch([file('01_Silly_Face_Dance/template_video.mp4')],[{id:'db-id',slug:'recast-recvxqZu2pVeTH',title:'搞怪舞蹈'}]);
 assert.equal(job.target.id,'db-id');
});
test('manifest works when selecting only a template subfolder',()=>{
 const [job]=planVideoBatch([file('01_Test/template_video.mp4')],[{id:'db',slug:'original-id',title:'已改名'}],[{id:'original-id',local:{template_video:'assets/01_Test/template_video.mp4'}}]);
 assert.equal(job.target.id,'db');
});
test('number prefixes on stored titles normalize consistently without substring matching',()=>{
 const [job]=planVideoBatch([file('01_Silly_Face_Dance/template_video.mp4')],[{id:'db',slug:'custom',title:'01_Silly Face Dance'}]);
 assert.equal(job.target.id,'db');
 assert.throws(()=>planVideoBatch([file('01_Silly_Face_Dance/template_video.mp4')],[{id:'db',slug:'custom',title:'Other Silly Face Dance Extra'}]),/0 个/);
});
