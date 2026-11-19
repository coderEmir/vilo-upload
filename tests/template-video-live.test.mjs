import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/App.vue',import.meta.url),'utf8');
const handler = ts.transpile(source.slice(source.indexOf('async function importVideoDirectory('),source.indexOf('const currentEpisode =')), {target:ts.ScriptTarget.ES2022});
test('persists and displays each uploaded video before uploading the next; never reloads',async()=>{
 const calls=[];
 const ref=value=>({value});
 const target={id:'t',title:'Test'};
 const input=new File(['i'],'template_video.mp4');
 const preview=new File(['r'],'result_video.mp4');
 const context={loading:ref(false),importing:ref(false),error:ref(''),notice:ref(''),templates:ref([{...target,type:'SHORT_VIDEO'}]),draft:ref(null),
 planVideoBatch:()=>[{target,input,preview}],
 request:async(_,init)=>{const body=JSON.parse(init.body);calls.push(body.validateOnly?'validate':body.previewUrl?'save-preview':'save-input');return {template:{...target,episodes:[]}};},
 uploadAssetFile:async file=>{calls.push(file.name);return 'https://oss.example/'+file.name;},
 upsertLocalTemplate:t=>{calls.push('local');return t;},
 };
 const run=new Function('context',`with(context){${handler};return importVideoDirectory;}`)(context);
 await run({target:{files:[input,preview],value:''}});
 assert.deepEqual(calls,['validate','template_video.mp4','save-input','local','result_video.mp4','save-preview','local']);
 assert.equal(context.error.value,'');
});
