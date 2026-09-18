import { Worker } from "node:worker_threads";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { LibraryStatus, LibraryQuery } from "../../shared/library";
import type { LibraryInventory } from "./library-engine";

export const libraryQuerySchema = z.object({ query:z.string().max(2000), documentId:z.string().max(100).optional(), courseIds:z.array(z.string().max(100)).max(100).optional(), module:z.string().max(300).optional(), fileType:z.string().max(12).optional(), kind:z.enum(["all","text","visual"]).optional(), archived:z.boolean().optional(), similarTo:z.string().max(200).optional(), limit:z.number().int().min(1).max(100).optional() });
export class LibraryService {
  private snapshots = new Map<string,Record<string,string>>();
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve:(value:unknown)=>void; reject:(error:Error)=>void; timeout:ReturnType<typeof setTimeout> }>();
  state: LibraryStatus = { state:"idle",completed:0,total:0,issues:[],modelsReady:false,documents:0,passages:0 };
  constructor(root: string, library: string, onStatus: (status:LibraryStatus)=>void) {
    this.worker = new Worker(path.join(import.meta.dirname,"library-worker.js"), { workerData:{root,library} });
    this.worker.on("message", message => {
      if (message.status) { this.state = message.status; onStatus(this.state); return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timeout); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    const fail = (error: Error) => { for (const p of this.pending.values()) { clearTimeout(p.timeout);p.reject(error); } this.pending.clear(); this.state = {...this.state,state:"failed",error:"Local search worker stopped. Restart StudyFlow to retry."}; onStatus(this.state); };
    this.worker.on("error",fail);
    this.worker.on("exit",code => { if (code) fail(new Error("Local search worker stopped.")); });
  }
  call<T>(method:string,input?:unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve,reject) => { const timeout = setTimeout(() => { this.pending.delete(id);reject(new Error("Local search is taking too long. Retry after indexing finishes.")); },120000); this.pending.set(id,{resolve:resolve as (value:unknown)=>void,reject,timeout}); this.worker.postMessage({id,method,input}); });
  }
  update(inventory:LibraryInventory) { return this.call("inventory",inventory); }
  async freeze(workspace:string,allowed:string[]) { const snapshot = await this.call<Record<string,string>>("snapshot",allowed); this.snapshots.set(workspace,snapshot); await writeFile(path.join(workspace,"source-snapshot.json"),JSON.stringify({allowedCourseIds:allowed,revisions:snapshot},null,2)); return Object.keys(snapshot).length; }
  release(workspace:string) {this.snapshots.delete(workspace);}
  async agent(tool:string,args:unknown,workspace:string,allowed:string[]) {
    const snapshot = this.snapshots.get(workspace); if (!snapshot) throw new Error("Assignment source snapshot is unavailable.");
    if (tool === "studyflow_search") { const query = libraryQuerySchema.parse(args); return this.call("scoped-search",{query:{...query,courseIds:allowed,archived:false,limit:12} satisfies LibraryQuery,snapshot}); }
    const input = z.object({id:z.string().min(1).max(200)}).parse(args);
    if (tool === "studyflow_related") return this.call("related",{id:input.id,allowed});
    if (tool === "studyflow_include") { const [document,revision] = input.id.split(":"); if(snapshot[document]!==revision) throw new Error("Source revision is outside this assignment's frozen snapshot."); return this.call("include",{id:input.id,allowed,workspace}); }
    throw new Error("Unknown retrieval tool.");
  }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timeout);pending.reject(new Error("StudyFlow closed.")); } this.pending.clear(); void this.worker.terminate(); }
}
export const RETRIEVAL_TOOLS = [
  {name:"studyflow_search",description:"Search ONLY approved courses by meaning, keywords or diagram similarity. Returns source IDs, revisions, snippets and page locations. Use studyflow_include to read original evidence. Does not read Canvas or the internet.",inputSchema:{type:"object",properties:{query:{type:"string"},kind:{type:"string",enum:["all","text","visual"]},similarTo:{type:"string"}},required:["query"],additionalProperties:false}},
  {name:"studyflow_related",description:"Find explicit or suggested connections for a documentId within approved courses. Similarity is not evidence of a required source.",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}},
  {name:"studyflow_include",description:"Copy a search result id's immutable original revision and extracted text into this workspace. Returns paths for studyflow_documents read/view. Inspect original figures before solving.",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}},
].map(tool => ({type:"function",...tool}));
