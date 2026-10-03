import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexBrowserExecutor } from "../src/codex-browser-executor.mjs";
import { createBrowserDependencySnapshot, pruneBrowserSnapshots, verifyBrowserDependencySnapshot } from "../src/browser-dependency-snapshot.mjs";

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexless-browser-snapshot-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = path.join(base, "owned", "v1");
  async function source(build) {
    const dir = path.join(base, build);
    const roots = Object.fromEntries(["chrome", "browser", "node", "codex"].map((role) => [role, path.join(dir, role)]));
    const exe = process.platform === "win32" ? ".exe" : "";
    const files = {
      "chrome/.codex-plugin/plugin.json": JSON.stringify({name:"chrome",version:build}),
      "browser/.codex-plugin/plugin.json": JSON.stringify({name:"browser",version:build}),
      "chrome/scripts/browser-client.mjs": "export const fixture = true;\n",
      "browser/scripts/browser-service.mjs": `export const fixture = ${JSON.stringify(build)};\n`,
      "browser/docs/api.json": "{}", "browser/docs/browser-safety.md": "fixture",
      "browser/scripts/browser-accessibility.wasm.br": "wasm-fixture", "browser/scripts/zxing_reader.wasm": "wasm-fixture",
      "browser/node_modules/classic-level.mjs": "export {};",
      [`node/node_repl${exe}`]: `node-repl-${build}`, [`node/node${exe}`]: "node-fixture",
      "node/node_modules/@oai/sky/package.json": JSON.stringify({name:"@oai/sky",exports:{"./service":"./service.js"}}),
      "node/node_modules/@oai/sky/service.js": "export {};",
      [`codex/codex${exe}`]: "codex-fixture",
      [`codex/codex-command-runner${exe}`]: "runner-fixture",
      [`codex/codex-windows-sandbox-setup${exe}`]: "setup-fixture",
      [`codex/codex-code-mode-host${exe}`]: "code-mode-fixture",
    };
    for (const [relative, text] of Object.entries(files)) {
      const file = path.join(dir,...relative.split("/")); await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);
    }
    const compatibility = {status:"ok",build,chromePluginRoot:roots.chrome,chromeSkillPath:null,browserRuntimeCwd:base,
      browserClientPath:path.join(roots.chrome,"scripts/browser-client.mjs"),browserServicePath:path.join(roots.browser,"scripts/browser-service.mjs"),
      browserClientSha256:createHash("sha256").update(files["chrome/scripts/browser-client.mjs"]).digest("hex"),overrides:[]};
    const nodeReplConfig={command:path.join(roots.node,`node_repl${exe}`),args:[],env:{
      BROWSER_USE_CODEX_APP_VERSION:build,NODE_REPL_NODE_PATH:path.join(roots.node,`node${exe}`),NODE_REPL_NODE_MODULE_DIRS:path.join(roots.node,"node_modules"),
      NODE_REPL_TRUSTED_CODE_PATHS:[roots.chrome,roots.browser,path.join(roots.node,"node_modules")].join(path.delimiter),
      NODE_REPL_TRUSTED_SERVICES:JSON.stringify({browser:compatibility.browserServicePath,sky:"@oai/sky/service"})}};
    return {dir,roots,compatibility,nodeReplConfig,codexBin:path.join(roots.codex,`codex${exe}`),store};
  }
  async function bind(source) { const bound=await createBrowserDependencySnapshot(source);t.after(bound.release);await bound.markReady();return bound; }
  return {base,store,source,bind};
}
function browser(binding) {
  let dispatches=0;
  const backend={id:"fixture-exact-backend",name:"Chrome",family:"chrome",type:"extension",capabilities:{listTabs:true,claimTabs:true,openTab:true}};
  const workbench={generation:1,async catalog({kind}){assert.equal(kind,"mcp","active snapshots must not rediscover source skills");return {servers:[{name:"node_repl",tools:[{name:"js"}]}]};},
    async currentChromePlugin(){throw new Error("source discovery must not run after binding");},
    async mcpCall({arguments:args}) {dispatches++;const data=(args.code.includes("const __twInventory = []")||args.code.includes("const __twBackends = await"))?[backend]:[];return {isError:false,text:JSON.stringify(data)};}};
  const executor=new CodexBrowserExecutor({workbench,defaultCwd:os.tmpdir(),runtimeCompatibility:binding.compatibility,
    runtimeCompatibilityResolver:()=>verifyBrowserDependencySnapshot(binding.compatibility)});
  return {executor,workbench,get dispatches(){return dispatches;}};
}
test("source A binds a coherent content-addressed snapshot, including node modules and complete CLI helpers",async t=>{
  const f=await fixture(t),a=await f.source("A"),x=await f.bind(a);
  assert.match(x.compatibility.snapshot.id,/^[a-f0-9]{64}$/);assert.equal((await verifyBrowserDependencySnapshot(x.compatibility)).status,"ok");
  assert.ok(x.codexBin.startsWith(x.compatibility.snapshot.root));assert.ok(x.nodeReplConfig.command.startsWith(x.compatibility.snapshot.root));
  assert.equal(await readFile(path.join(x.compatibility.snapshot.root,"node/node_modules/@oai/sky/service.js"),"utf8"),"export {};");
  assert.equal(x.reused,false);
  const admitted=x.nodeReplConfig.env.NODE_REPL_TRUSTED_CODE_PATHS.split(path.delimiter);
  assert.deepEqual(admitted,["browser","chrome","node/node_modules"].map(relative=>path.join(x.compatibility.snapshot.root,...relative.split("/"))));
  assert.ok(!admitted.includes(x.compatibility.snapshot.root),"never trust the snapshot store or an entire snapshot root");
});
test("materialization cannot widen source trusted-code admission",async t=>{
  const f=await fixture(t),a=await f.source("A");a.nodeReplConfig.env.NODE_REPL_TRUSTED_CODE_PATHS=path.join(a.roots.node,"node_modules");
  await assert.rejects(()=>createBrowserDependencySnapshot(a),error=>error.code==="browser_snapshot_untrusted_source");
});
test("source A removal and source B discovery never switch active X across sustained Browser checks",async t=>{
  const f=await fixture(t),a=await f.source("A"),x=await f.bind(a),live=browser(x);
  assert.equal((await live.executor.status()).status,"ok");
  await f.source("B");await rm(a.dir,{recursive:true});
  for(let n=0;n<20;n++){assert.equal((await live.executor.status()).status,"ok");assert.equal((await live.executor.listTabs({family:"chrome"})).count,0);}
  assert.ok(live.dispatches>=40);assert.equal(x.compatibility.build,"A");
});
test("a natural new binding chooses B and preserves previous verified X",async t=>{
  const f=await fixture(t),x=await f.bind(await f.source("A")),y=await f.bind(await f.source("B"));
  assert.notEqual(x.compatibility.snapshot.id,y.compatibility.snapshot.id);
  assert.equal((await verifyBrowserDependencySnapshot(x.compatibility)).status,"ok");
  assert.equal((await verifyBrowserDependencySnapshot(y.compatibility)).status,"ok");
  const history=JSON.parse(await readFile(path.join(f.store,"history.json"),"utf8"));assert.equal(history.previous,x.compatibility.snapshot.id);assert.equal(history.current,y.compatibility.snapshot.id);
});
test("identical content is reused; source and snapshot mtimes are irrelevant",async t=>{
  const f=await fixture(t),a=await f.source("A"),x=await f.bind(a);
  await utimes(a.compatibility.browserClientPath,new Date(0),new Date(0));
  await utimes(x.compatibility.browserClientPath,new Date(0),new Date(0));
  const again=await f.bind(a);assert.equal(again.reused,true);assert.equal(again.compatibility.snapshot.id,x.compatibility.snapshot.id);
  assert.equal(again.compatibility.snapshot.manifestSha256,x.compatibility.snapshot.manifestSha256);
});
for(const role of ["chrome","browser","node","codex"]) test(`critical ${role} snapshot mutation fails before Browser dispatch`,async t=>{
  const f=await fixture(t),x=await f.bind(await f.source("A")),live=browser(x);
  const manifest=JSON.parse(await readFile(path.join(x.compatibility.snapshot.root,"manifest.json"),"utf8"));
  const entry=role==="node"?manifest.identity.entrypoints.nodeRepl:role==="codex"?manifest.identity.entrypoints.codex:role==="chrome"?manifest.identity.entrypoints.client:manifest.identity.entrypoints.service;
  const file=path.join(x.compatibility.snapshot.root,...entry.split("/"));const before=await stat(file);const bytes=await readFile(file);
  bytes[0]^=1;await writeFile(file,bytes);await utimes(file,before.atime,before.mtime); // Size and mtime spoofing must not hide content changes.
  const status=await live.executor.status();assert.equal(status.reason,"BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED");assert.deepEqual(status.changedComponents,[role]);
  await assert.rejects(()=>live.executor.listTabs({}),error=>error.code==="BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED");assert.equal(live.dispatches,0);
});
test("missing active file and mutated manifest both fail closed",async t=>{
  const f=await fixture(t),x=await f.bind(await f.source("A"));await rm(x.compatibility.browserServicePath);
  assert.equal((await verifyBrowserDependencySnapshot(x.compatibility)).status,"unavailable");
  const y=await f.bind(await f.source("B"));await writeFile(path.join(y.compatibility.snapshot.root,"manifest.json"),"{}");
  assert.equal((await verifyBrowserDependencySnapshot(y.compatibility)).status,"unavailable");
});
test("incomplete or generation-incoherent sources never publish",async t=>{
  const f=await fixture(t),a=await f.source("A");await rm(a.nodeReplConfig.command);
  await assert.rejects(()=>createBrowserDependencySnapshot(a));assert.equal((await readdir(f.store)).some(name=>/^[a-f0-9]{64}$/.test(name)),false);
  const b=await f.source("B");b.nodeReplConfig.env.BROWSER_USE_CODEX_APP_VERSION="A";
  await assert.rejects(()=>createBrowserDependencySnapshot(b),error=>error.code==="browser_snapshot_coherence_failed");
});
test("junction/symlink source escape is refused and no target is copied",async t=>{
  const f=await fixture(t),a=await f.source("A"),outside=path.join(f.base,"outside");await mkdir(outside);await writeFile(path.join(outside,"private.txt"),"fixture-secret");
  await symlink(outside,path.join(a.roots.node,"escape"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(()=>createBrowserDependencySnapshot(a),error=>error.code==="browser_snapshot_path_untrusted");
  await rm(path.join(a.roots.node,"escape"));assert.equal(await readFile(path.join(outside,"private.txt"),"utf8"),"fixture-secret");
});
test("cleanup retains all live leases and rollback, and bounds deletion",async t=>{
  const f=await fixture(t),snapshots=[];
  for(const name of ["A","B","C","D","E"]){const src=await f.source(name);const x=await createBrowserDependencySnapshot({...src,prune:false});await x.markReady();snapshots.push(x);t.after(x.release);}
  await snapshots[1].release();await snapshots[2].release();
  const result=await pruneBrowserSnapshots(f.store);assert.equal(result.deleted,2);
  for(const i of [0,3,4])assert.equal((await verifyBrowserDependencySnapshot(snapshots[i].compatibility)).status,"ok");
});
test("process interruption during staging leaves prior snapshot valid and an inert stage",async t=>{
  const f=await fixture(t),x=await f.bind(await f.source("A")),b=await f.source("B");
  await writeFile(path.join(b.roots.node,"000-large.bin"),Buffer.alloc(32*1024*1024,17));
  const module=pathToFileURL(path.resolve(import.meta.dirname,"../src/browser-dependency-snapshot.mjs")).href;
  const script=path.join(f.base,"interrupted.mjs");await writeFile(script,`import {createBrowserDependencySnapshot} from ${JSON.stringify(module)};await createBrowserDependencySnapshot(${JSON.stringify(b)});`);
  const child=spawn(process.execPath,[script],{stdio:"ignore",windowsHide:true});
  const ended=new Promise(resolve=>child.once("exit",resolve));t.after(()=>child.kill());
  const deadline=Date.now()+10000;let sawStage=false;
  while(Date.now()<deadline){const stages=(await readdir(f.store)).filter(name=>name.startsWith(".staging-"));if(await Promise.all(stages.map(name=>readFile(path.join(f.store,name,"stage-owner.json"),"utf8").then(text=>Boolean(JSON.parse(text).token),()=>false))).then(items=>items.some(Boolean))){sawStage=true;child.kill();break;}await new Promise(resolve=>setTimeout(resolve,5));}
  await ended;assert.equal(sawStage,true);assert.equal((await verifyBrowserDependencySnapshot(x.compatibility)).status,"ok");
  assert.equal((await readdir(f.store)).some(name=>name.startsWith(".staging-")),true);
  const y=await f.bind(b);assert.equal((await verifyBrowserDependencySnapshot(y.compatibility)).status,"ok","dead transaction owner must not prevent the next binding");
  assert.equal((await readdir(f.store)).some(name=>name.startsWith(".staging-")),false,"dead owned stage is safely reclaimed");
});
test("failed bootstrap cannot displace known-good rollback history",async t=>{
  const f=await fixture(t),x=await f.bind(await f.source("A")),y=await f.bind(await f.source("B"));
  const failed=await createBrowserDependencySnapshot(await f.source("C"));t.after(failed.release);
  const history=JSON.parse(await readFile(path.join(f.store,"history.json"),"utf8"));
  assert.deepEqual(history,{current:y.compatibility.snapshot.id,previous:x.compatibility.snapshot.id});
});
test("cleanup refuses corrupt rollback evidence and retains verified generations",async t=>{
  const f=await fixture(t),x=await f.bind(await f.source("A"));await x.release();
  await writeFile(path.join(f.store,"history.json"),"{}");
  await assert.rejects(()=>pruneBrowserSnapshots(f.store),error=>error.code==="browser_snapshot_cleanup_ownership_unknown");
  assert.equal((await verifyBrowserDependencySnapshot(x.compatibility)).status,"ok");
});
test("concurrent materialization publishes one verified identical snapshot",async t=>{
  const f=await fixture(t),a=await f.source("A");
  const module=pathToFileURL(path.resolve(import.meta.dirname,"../src/browser-dependency-snapshot.mjs")).href;
  const script=path.join(f.base,"concurrent.mjs");await writeFile(script,`import {createBrowserDependencySnapshot} from ${JSON.stringify(module)};const x=await createBrowserDependencySnapshot(${JSON.stringify(a)});console.log(JSON.stringify({id:x.compatibility.snapshot.id,reused:x.reused}));await x.release();`);
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script],{windowsHide:true});let output="",error="";child.stdout.on("data",data=>output+=data);child.stderr.on("data",data=>error+=data);child.on("error",reject);child.on("exit",code=>code===0?resolve(JSON.parse(output)):reject(Error(error)));});
  const [x,y]=await Promise.all([run(),run()]);assert.equal(x.id,y.id);assert.equal(Number(x.reused)+Number(y.reused),1);
  assert.equal((await readdir(f.store)).filter(name=>/^[a-f0-9]{64}$/.test(name)).length,1);
});
test("bootstrap promotion never overwrites unknown rollback ownership",async t=>{
  const f=await fixture(t),x=await createBrowserDependencySnapshot(await f.source("A"));t.after(x.release);
  const history=path.join(f.store,"history.json");await writeFile(history,"{}");
  await assert.rejects(()=>x.markReady(),error=>error.code==="browser_snapshot_cleanup_ownership_unknown");
  assert.equal(await readFile(history,"utf8"),"{}");
});
test("observed integrity failure remains latched after byte restoration and child restart",async t=>{
  const f=await fixture(t),x=await f.bind(await f.source("A")),live=browser(x);
  const file=x.compatibility.browserServicePath,bytes=await readFile(file);
  await writeFile(file,"changed implementation");assert.equal((await live.executor.status()).reason,"BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED");
  await writeFile(file,bytes);live.workbench.generation++;
  assert.equal((await live.executor.status()).reason,"BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED");
  await assert.rejects(()=>live.executor.listTabs({}),error=>error.code==="BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED");assert.equal(live.dispatches,0);
  assert.equal((await browser(x).executor.status()).status,"ok","a fresh household can bind the verified restored generation");
});
