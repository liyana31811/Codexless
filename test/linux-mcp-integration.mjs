import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
if (process.platform !== "linux") { console.log("Linux integration SKIP (requires Linux)"); process.exit(0); }
const source = path.resolve(import.meta.dirname, "..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "codexless-linux-integration-"));
const project = path.join(fixture, "project with spaces");
const codexHome = path.join(fixture, "codex-home");
const outside = path.join(fixture, "outside.txt");
await mkdir(project); await mkdir(codexHome);
await writeFile(path.join(codexHome, "config.toml"), `approval_policy = "on-request"
sandbox_mode = "workspace-write"
[projects.${JSON.stringify(project)}]
trust_level = "trusted"
`);
await writeFile(path.join(project, "AGENTS.md"), "Linux isolated fixture: respect project boundaries; never start a model turn.\n");
await writeFile(path.join(project, "probe.txt"), "alpha Linux fixture\n");
await writeFile(outside, "outside authority\n");
await symlink(outside, path.join(project, "escape.txt"));
execFileSync("git", ["init", "--quiet"], { cwd: project });
const codex = (await resolveCodexExecutable()).path;
const env = { ...process.env, CODEX_HOME: codexHome, CODEX_BIN: codex,
 CODEXLESS_CODEX_RUNTIME: "existing", CODEXLESS_SERVER_NAME: "codexless-linux",
 CODEXLESS_DEFAULT_CWD: project, CODEXLESS_STATE_ROOT: path.join(fixture, "state"),
 CODEXLESS_AGENT_TASK_STATE_FILE: path.join(fixture, "state", "tasks.json") };
for (const name of Object.keys(env)) if (/^(OPENAI_API_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY|CONTROL_PLANE_API_KEY|CODEX_TOOLBOX_)/.test(name)) delete env[name];
const evidence = [];
const pass = (check, detail = true) => { evidence.push({check, status: "pass", detail}); console.log(`PASS ${check}`); };
const payload = result => result.structuredContent ?? JSON.parse(result.content[0].text);
const transport = new StdioClientTransport({command:process.execPath,args:[path.join(source,"scripts","launch.mjs"),"stdio"],cwd:source,env,stderr:"pipe"});
let stderr=""; transport.stderr?.on("data", chunk=>{stderr+=String(chunk);stderr=stderr.slice(-8000);});
const client = new Client({name:"codexless-linux-integration",version:"1.0.0"});
let httpChild;
try {
 await client.connect(transport);
 assert.equal(client.getServerVersion().name,"codexless-linux"); pass("stdio initialize / independent server identity");
 const listed = await client.listTools(); assert.deepEqual(listed.tools.map(t=>t.name).sort(),[...PUBLIC_TOOL_NAMES].sort());pass("tools/list public contract",listed.tools.length);
 async function command(command, access="readOnly", timeoutMs=5000) {
  const result=await client.callTool({name:"codex.command_exec",arguments:{command,cwd:project,access,timeoutMs}});
  const data=payload(result); assert.equal(typeof data.exitCode,"number",JSON.stringify(result)); return data;
 }
 let result = await command(["uname","-s"]); assert.equal(result.stdout.trim(),"Linux");pass("uname -s",result.stdout.trim());
 result=await command(["uname","-a"]);assert.match(result.stdout,/Linux/);pass("uname -a",result.stdout.trim());
 result=await command(["pwd"]);assert.equal(result.stdout.trim(),project);pass("pwd with spaces");
 result=await command(["git","status","--short","--branch"]);assert.equal(result.exitCode,0);pass("git status / branch");
 result=await command(["git","-C",source,"log","-1","--format=%h %s"]);assert.equal(result.exitCode,0);assert.ok(result.stdout.trim());pass("git commit history read");
 const context=await client.callTool({name:"codex.project_context",arguments:{cwd:project}});assert.notEqual(context.isError,true,JSON.stringify(context));assert.ok(JSON.stringify(payload(context)).includes("AGENTS.md"));pass("project context discovers AGENTS.md");
 result=await command(["find",".","-maxdepth","1","-type","f"]);assert.match(result.stdout,/AGENTS.md/);pass("directory list / file search");
 let read=await client.callTool({name:"codex.read_many",arguments:{cwd:project,paths:[path.join(project,"probe.txt"),"AGENTS.md"]}});
 assert.notEqual(read.isError,true,JSON.stringify(read));assert.match(payload(read).files[1].text,/respect project boundaries/);pass("read absolute file and AGENTS.md");
 result=await command([process.execPath,"-e","require('node:fs').writeFileSync('created.txt','created by sandbox\\n')"],"inherit");assert.equal(result.exitCode,0,JSON.stringify(result));assert.match(await readFile(path.join(project,"created.txt"),"utf8"),/created by sandbox/);pass("sandboxed create / write verification");
 const edit={cwd:project,path:"probe.txt",expectedText:"alpha",replacementText:"beta"};
 let edited=await client.callTool({name:"codex.precise_edit",arguments:{...edit,previewOnly:true}});assert.notEqual(edited.isError,true,JSON.stringify(edited));assert.match(await readFile(path.join(project,"probe.txt"),"utf8"),/^alpha/);pass("guarded edit preview");
 edited=await client.callTool({name:"codex.precise_edit",arguments:edit});assert.notEqual(edited.isError,true,JSON.stringify(edited));assert.match(await readFile(path.join(project,"probe.txt"),"utf8"),/^beta/);pass("sandboxed guarded edit / verify");
 result=await command(["git","diff","--no-index","/dev/null","probe.txt"]);assert.equal(result.exitCode,1);assert.match(result.stdout,/beta/);pass("git diff");
 result=await command(["mv","created.txt","moved.txt"],"inherit");assert.equal(result.exitCode,0);result=await command(["rm","--","moved.txt"],"inherit");assert.equal(result.exitCode,0);pass("authorized move / delete within fixture");
 for (const target of [outside,"escape.txt"]) {
  const rejected=await client.callTool({name:"codex.read_many",arguments:{cwd:project,paths:[target]}});assert.equal(rejected.isError,true,JSON.stringify(rejected));
 } pass("out-of-root / symlink escape rejected");
 result=await command([process.execPath,"-e","require('node:fs').writeFileSync('readonly-rejected.txt','no')"]);assert.notEqual(result.exitCode,0);pass("readOnly command write denied");
 const nested=await client.callTool({name:"codex.command_exec",arguments:{cwd:project,command:[codex,"--version"]}});assert.equal(nested.isError,true);assert.equal(payload(nested).errorCode,"FORMAL_CODEX_AGENT_REQUIRED");pass("nested Codex bypass rejected");
 const tooBroad=await client.callTool({name:"codex.command_exec",arguments:{cwd:project,command:["pwd"],permissionProfile:":danger-full-access"}});assert.equal(tooBroad.isError,true);pass("remote permission override rejected by schema");
 result=await command([process.execPath,"-e","console.error('bounded-stderr');process.exitCode=7"]);assert.equal(result.exitCode,7);assert.match(result.stderr,/bounded-stderr/);pass("stderr and nonzero exit propagation");
 const start=Date.now();result=await command([process.execPath,"-e","setInterval(()=>{},1000)"],"readOnly",300);assert.ok(Date.now()-start<10000);assert.notEqual(result.exitCode,0);pass("timeout and command cleanup");
 const prepared=await client.callTool({name:"codex.agent_start",arguments:{cwd:project,prompt:"Prepare-only Linux consent verification. Do not start a model.",requestId:"linux-integration-prepare",invocationRationale:"Verify explicit model approval boundary"}});
 assert.notEqual(prepared.isError,true,JSON.stringify(prepared));const task=payload(prepared);assert.equal(task.status,"consent_required");assert.equal(task.turnId,null);
 const replay=payload(await client.callTool({name:"codex.agent_start",arguments:{cwd:project,prompt:"Prepare-only Linux consent verification. Do not start a model.",requestId:"linux-integration-prepare",invocationRationale:"Verify explicit model approval boundary"}}));assert.equal(replay.taskId,task.taskId);assert.equal(replay.turnId,null);
 const declined=payload(await client.callTool({name:"codex.agent_decline",arguments:{taskId:task.taskId}}));assert.equal(declined.status,"rejected");pass("metered model prepare / duplicate / decline without model call");
 await client.close(); await transport.close();
 // Ephemeral loopback HTTP test only; no persistent user service is enabled.
 const net=await import("node:net");const probe=net.createServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 httpChild=spawn(process.execPath,[path.join(source,"scripts","launch.mjs"),"http"],{cwd:source,env:{...env,CODEX_TOOLBOX_PUBLIC_HOST:"127.0.0.1",CODEX_TOOLBOX_PUBLIC_PORT:String(port)},stdio:["ignore","pipe","pipe"]});
 httpChild.stderr.on("data",c=>{stderr+=String(c);stderr=stderr.slice(-8000);});
 const base=`http://127.0.0.1:${port}`;let health;
 for(let i=0;i<150;i++){if(httpChild.exitCode!==null)throw new Error(stderr);try{const h=await fetch(base+"/healthz");if(h.ok){health=await h.json();break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal(health?.ok,true,stderr);assert.equal(health.toolCount,45);assert.equal((await fetch(base+"/readyz")).status,200);assert.equal(health.defaultCwd,undefined);pass("loopback health / ready / no project path leakage");
 assert.notEqual((await fetch(base+"/mcp",{method:"POST",headers:{origin:"https://untrusted.invalid","content-type":"application/json"},body:"{}"})).status,200);pass("HTTP foreign Origin rejected");
 const hc=new Client({name:"codexless-linux-http-test",version:"1.0.0"});try{await hc.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp")));assert.equal(hc.getServerVersion().name,"codexless-linux");assert.equal((await hc.listTools()).tools.length,45);const called=payload(await hc.callTool({name:"codex.command_exec",arguments:{command:["uname","-s"],cwd:project}}));assert.equal(called.stdout.trim(),"Linux");pass("HTTP initialize / discovery / actual Linux tool call");}finally{await hc.close();}
} catch(error) { console.error(stderr);throw error; }
finally {
 await client.close().catch(()=>{});await transport.close().catch(()=>{});
 if(httpChild&&httpChild.exitCode===null){const done=once(httpChild,"exit");httpChild.kill("SIGTERM");await Promise.race([done,new Promise(r=>setTimeout(r,5000))]);if(httpChild.exitCode===null)httpChild.kill("SIGKILL");}
 if(process.env.CODEXLESS_LINUX_TEST_REPORT)await writeFile(process.env.CODEXLESS_LINUX_TEST_REPORT,JSON.stringify({platform:process.platform,codexVersion:(await resolveCodexExecutable()).version,checks:evidence,modelTurnStarted:false},null,2)+"\n");
 await rm(fixture,{recursive:true,force:true});
}
console.log(`Linux MCP integration PASS (${evidence.length} checks)`);
