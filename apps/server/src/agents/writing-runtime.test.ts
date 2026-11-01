import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readProposals } from './writing-runtime.js';
test('proposals are allowlisted, bounded, and reject symlinked directories and files', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ocf-proposals-'));
 try {
  const dir = join(root,'agent-workspaces','article','outputs','turn'); await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'article.md'),'# Full draft');
  expect((await readProposals(root,'article','turn')).draft?.markdown).toBe('# Full draft');
  await symlink(join(dir,'article.md'),join(dir,'outline.md'));
  expect((await readProposals(root,'article','turn')).outline).toBeNull();
  await writeFile(join(dir,'article.md'),'x'.repeat(100_001));
  expect((await readProposals(root,'article','turn')).draft).toBeNull();
  expect((await readProposals(root,'article','../turn')).draft).toBeNull();
  await rename(dir,join(root,'moved')); await symlink(join(root,'moved'),dir);
  expect(await readProposals(root,'article','turn')).toEqual({outline:null,draft:null});
 } finally { await rm(root,{recursive:true,force:true}); }
});

import { readFile } from 'node:fs/promises';
import { createApp } from '../app.js';
const headers = {'x-ocf-client':'1'};
test('native turns preserve full selected markdown, context history, approved outline and staged proposals', async () => {
 const root = await mkdtemp(join(tmpdir(),'ocf-packet-')); const dataDir = join(root,'data');
 const vault = join(root,'vault'); await mkdir(vault); const full = '# Source\n' + 'full material\n'.repeat(5000); await writeFile(join(vault,'Note.md'),full); await writeFile(join(vault,'Other.md'),'not selected');
 let received: any, release!: () => void; let count = 0;
 const app = createApp({dataDir,agentOptions:{claudePath:'/fake/claude',environment:{},runner:async input => {
  received = JSON.parse(await readFile(join(input.cwd,'inputs',input.context!.id,'manifest.json'),'utf8'));
  expect(input.prompt).toContain(received.sources[0]?.nativePath ?? '本轮参考清单');
  if(count++ === 0) {
   expect(received.sources.map((s:any) => s.id)).toEqual(['S1']);
   expect(received.sources[0]).toMatchObject({startLine:2,endLine:3});
   expect(await readFile(received.sources[0].nativePath,'utf8')).toBe(full);
   expect(await readFile(received.outlinePath,'utf8')).toBe('# Approved');
   await writeFile(join(received.outputDirectory,'article.md'),'# Proposed');
   await new Promise<void>(r => {release=r;});
  } else { expect(received.sources).toEqual([]); expect(input.nativeSessionId).toBe('native-session'); }
  return {text:'review proposal',sessionId:'native-session'};
 }}});
 try {
  expect((await app.inject({method:'POST',url:'/api/v1/vaults',headers,payload:{id:'one',path:vault,adopt:true}})).statusCode).toBe(201);
  const article = (await app.inject({method:'POST',url:'/api/v1/articles',headers,payload:{}})).json(); const base = `/api/v1/articles/${article.id}`;
  const saved = await app.inject({method:'PUT',url:`${base}/context`,headers,payload:{expectedRevision:0,vaultIds:['one'],materials:[{vaultId:'one',path:'Note.md'},{vaultId:'one',path:'Other.md'}]}}); expect(saved.statusCode).toBe(200);
  await app.inject({method:'PUT',url:`${base}/outline`,headers,payload:{expectedRevision:1,markdown:'# Approved'}});
  await app.inject({method:'POST',url:`${base}/outline/approve`,headers,payload:{expectedRevision:2}});
  const start = await app.inject({method:'POST',url:`${base}/agent/runs`,headers,payload:{profileId:'claude-current',content:'write',selections:[{materialId:'S1',startLine:2,endLine:3}]}}); expect(start.statusCode).toBe(202);
  for(let n=0;!release && n<100;n++) await new Promise(r=>setTimeout(r,5)); expect(release).toBeTypeOf('function');
  expect((await app.inject({url:`${base}/writing-proposals`})).json().draft).toBeNull();
  release();
  let history:any;
  for(let n=0;n<100;n++) {history=(await app.inject({url:`${base}/agent?profileId=claude-current`})).json(); if(history.run.status==='completed') break; await new Promise(r=>setTimeout(r,5));}
  expect(history.run.status).toBe('completed'); expect(history.messages.map((m:any)=>m.context)).toEqual([history.run.context,history.run.context]);
  expect((await app.inject({url:`${base}/writing-proposals`})).json().draft.markdown).toBe('# Proposed');
  const second = await app.inject({method:'POST',url:`${base}/agent/runs`,headers,payload:{profileId:'claude-current',content:'again',selections:[]}}); expect(second.statusCode).toBe(202);
  for(let n=0;n<100;n++) {history=(await app.inject({url:`${base}/agent?profileId=claude-current`})).json(); if(history.run.status==='completed') break; await new Promise(r=>setTimeout(r,5));}
  expect(history.run.status).toBe('completed');
  const another = (await app.inject({method:'POST',url:'/api/v1/articles',headers,payload:{}})).json();
  expect((await app.inject({url:`/api/v1/articles/${another.id}/writing-proposals`})).json()).toEqual({outline:null,draft:null});
  expect((await app.inject({method:'POST',url:`${base}/agent/runs`,headers,payload:{profileId:'claude-current',content:'bad',selections:[{materialId:'S99'}]}})).statusCode).toBe(422);
 } finally {release?.();await app.close();await rm(root,{recursive:true,force:true});}
});

import { stageWritingTurn } from './writing-runtime.js';
import type { WritingContextStore } from '../articles/writing-context.js';
import type { VaultRegistry } from '../vaults/registry.js';
test('requested local skill preserves original root for relative dependencies', async () => {
 const root = await mkdtemp(join(tmpdir(),'ocf-skill-root-'));
 try {
  const skillRoot = join(root,'writer'); await mkdir(join(skillRoot,'references'),{recursive:true});
  const skillPath = join(skillRoot,'SKILL.md'); await writeFile(skillPath,'Read references/guide.md'); await writeFile(join(skillRoot,'references','guide.md'),'Actual local guide');
  const store = {get:async()=>({materials:[]}),createTurn:async()=>({id:'turn',sources:[],vaultIds:[],skillRequested:true,outlineRevision:null}),outline:async()=>({approved:false,revision:0}),skillStatus:()=>({available:true,path:skillPath})} as unknown as WritingContextStore;
  const packet = await stageWritingTurn(root,'article','',store,{} as VaultRegistry);
  const manifest = JSON.parse(await readFile(join(packet.cwd,'inputs','turn','manifest.json'),'utf8'));
  expect(manifest.skillPath).toBe(skillPath); expect(manifest.skillRoot).toBe(skillRoot);
  expect(await readFile(join(manifest.skillRoot,'references','guide.md'),'utf8')).toBe('Actual local guide');
  expect(packet.prompt).toContain('请求'); expect(packet.prompt).toContain(skillRoot);
 } finally {await rm(root,{recursive:true,force:true});}
});
