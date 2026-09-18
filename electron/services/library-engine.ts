import Database from "better-sqlite3";
import { mkdir, readdir, readFile, writeFile, stat, lstat, realpath, cp } from "node:fs/promises";
import path from "node:path";
import type { Course, Assignment } from "../../shared/types";
import type { LibraryQuery, LibraryHit, LibraryLink, LibraryGraph, LibraryPreview, LibraryStatus, LinkKind } from "../../shared/library";
import { digest, ftsQuery, fuse, normalize, topVectors } from "./library-core";
import { LibraryModels } from "./library-models";
import { LibraryExtractor } from "./library-extract";
import { LibraryDescriptions, DESCRIPTION_VERSION, descriptionPassages } from "./library-descriptions";
import { sanitizeFileName } from "./utils";
import { assignmentSearchQuery, topicTerms } from "./assignment-search";
import type { AssignmentMaterials, AssignmentMaterialSuggestion } from "../../shared/library";

interface Doc { id: string; course: string; title: string; relative: string; revision: string; archived: number; module: string; type: string }
interface Passage { id: string; doc: string; revision: string; text: string; location: string; image: string | null; warning: string | null; vector: Buffer | null }
export interface LibraryInventory { courses: Course[]; assignments: Assignment[] }
export class LibraryEngine {
  private db!: Database.Database;
  readonly models: LibraryModels;
  readonly descriptions: LibraryDescriptions;
  private extractor = new LibraryExtractor();
  private vectors: Array<{ id: string; course: string; image: boolean; vector: Float32Array }> | null = null;
  private docVectors: Array<{id:string;course:string;image:boolean;vector:Float32Array}> | null = null;
  private controller?: AbortController;
  private paused = false;
  private setupActive = false;
  private resume?: () => void;
  private inventory: LibraryInventory = { courses: [], assignments: [] };
  private pendingInventory?: LibraryInventory;
  private materialCache = new Map<string, AssignmentMaterials>();
  private materialEpoch = 0;
  state: LibraryStatus = { state: "idle", completed: 0, total: 0, issues: [], modelsReady: false, documents: 0, passages: 0 };
  constructor(readonly root: string, readonly library: string, private notify: (state: LibraryStatus) => void = () => {}) { this.models = new LibraryModels(path.join(root, "models")); this.descriptions = new LibraryDescriptions(path.join(root, "models")); }
  async init() {
    await mkdir(this.root, { recursive: true });
    this.db = new Database(path.join(this.root, "search.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, course TEXT, title TEXT, relative TEXT, revision TEXT, archived INTEGER, module TEXT, type TEXT);
      CREATE TABLE IF NOT EXISTS revisions(doc TEXT, revision TEXT, source TEXT, extracted TEXT, embedded INTEGER, PRIMARY KEY(doc,revision));
      CREATE TABLE IF NOT EXISTS passages(id TEXT PRIMARY KEY, doc TEXT, revision TEXT, text TEXT, location TEXT, image TEXT, warning TEXT, vector BLOB);
      CREATE INDEX IF NOT EXISTS passages_document ON passages(doc,revision);
      CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(id UNINDEXED, title, text, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY, source TEXT, target TEXT, kind TEXT, reason TEXT, pinned INTEGER DEFAULT 0, dismissed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, course TEXT, title TEXT, kind TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`);
    this.db.exec("CREATE TABLE IF NOT EXISTS visual_descriptions(image_hash TEXT, model TEXT, description TEXT, PRIMARY KEY(image_hash,model))");
    const columns = this.db.pragma("table_info(revisions)") as Array<{name:string}>;
    if (!columns.some(column => column.name === "description_version")) this.db.exec("ALTER TABLE revisions ADD COLUMN description_version TEXT");
    this.db.exec("CREATE TEMP TABLE search_scope(doc TEXT PRIMARY KEY, revision TEXT) WITHOUT ROWID");
    this.db.prepare("INSERT INTO passage_fts(passage_fts,rank) VALUES ('rank','bm25(0,3,1)')").run();
    this.state.modelsReady = await this.models.verify();
    await this.descriptions.assets.verify();
    const checkpoint = this.db.prepare("SELECT value FROM settings WHERE key='index-progress'").get() as { value: string } | undefined;
    if (checkpoint) {
      const saved = JSON.parse(checkpoint.value) as Pick<LibraryStatus, "completed" | "total" | "filename" | "issues"> & { interrupted: boolean };
      this.state = { ...this.state, completed: saved.completed, total: saved.total, filename: saved.filename, issues: saved.issues,
        error: saved.interrupted ? "Indexing stopped. Completed files are saved; refresh the index to continue without re-extracting unchanged files." : undefined };
    }
    this.publish();
  }
  private saveProgress(completed = this.state.completed, interrupted = true) {
    this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('index-progress',?)").run(JSON.stringify({
      completed, total: this.state.total, filename: this.state.filename, issues: this.state.issues, interrupted,
    }));
  }
  private saveFileCheckpoint(course: Course, id: string) {
    this.materialCache.clear();
    this.materialEpoch++;
    this.db.prepare("INSERT OR REPLACE INTO nodes VALUES (?,?,?,?)").run(`course:${course.id}`, course.id, course.name, "course");
    this.edge(`course:${course.id}`, id, "membership", "Course membership");
    this.saveProgress(this.state.completed + 1);
  }
  private publish() {
    this.state.documents = (this.db.prepare("SELECT count(*) n FROM docs WHERE archived=0").get() as {n:number}).n;
    this.state.passages = (this.db.prepare("SELECT count(*) n FROM passages p JOIN docs d ON p.doc=d.id AND p.revision=d.revision WHERE d.archived=0").get() as {n:number}).n;
    this.state.modelsReady = this.models.ready; this.state.descriptionsReady = this.descriptions.ready; this.notify({ ...this.state });
  }
  async safe(file: string, root = this.root): Promise<string> {
    const base = await realpath(root); const relative = path.relative(base, path.resolve(file));
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(":")) throw new Error("Library path is outside its approved root.");
    let current = base;
    for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error("Library links are not allowed."); }
    return realpath(current);
  }
  private async checkpoint() {
    this.controller?.signal.throwIfAborted();
    if (this.paused) await new Promise<void>(resolve => { this.resume = resolve; });
    this.controller?.signal.throwIfAborted();
  }
  control(action: "pause" | "resume" | "cancel") {
    if (action === "pause" && this.controller) { this.paused = true; this.state.state = "paused"; }
    if (action !== "pause") { this.paused = false; this.resume?.(); this.resume = undefined; }
    if (action === "cancel") { this.pendingInventory = undefined; this.controller?.abort(); }
    if (action === "resume" && this.controller) this.state.state = this.setupActive?"downloading":"indexing";
    this.publish(); return this.state;
  }
  start(inventory: LibraryInventory, setup: boolean | "descriptions" = false): LibraryStatus {
    this.inventory = inventory;
    if (this.controller) { if (!setup) this.pendingInventory = inventory; return this.state; }
    this.controller = new AbortController(); this.paused = false; this.setupActive = Boolean(setup);
    this.state = { ...this.state, state: setup ? "downloading" : "indexing", completed: 0, total: 0, filename: undefined, error: undefined, issues: [] };
    this.publish();
    void (async () => {
      try {
        if (setup) await (setup === "descriptions" ? this.descriptions.assets : this.models).setup(this.controller!.signal, (filename, received, bytes) => { this.state = { ...this.state, filename, received, bytes }; this.publish(); },()=>this.checkpoint());
        this.setupActive = false;
        this.state.state = "indexing"; this.state.received = undefined; this.state.bytes = undefined;
        await this.index(inventory); this.state.state = "idle"; this.saveProgress(this.state.completed, false);
      } catch (error) { this.state.state = this.controller?.signal.aborted ? "idle" : "failed"; this.state.error = this.controller?.signal.aborted ? "Indexing cancelled. Completed documents are available." : String(error instanceof Error ? error.message : error); }
      finally { await this.extractor.close(); this.controller = undefined; this.paused = false; this.publish(); const next = this.pendingInventory; this.pendingInventory = undefined; if (next) this.start(next); }
    })();
    return this.state;
  }
  async index(inventory: LibraryInventory) {
    const files: Array<{ file: string; course: Course; relative: string }> = [];
    const visitedCourses = new Set<string>();
    for (const course of inventory.courses) {
      const folder = path.join(this.library, sanitizeFileName(course.name));
      try { await this.safe(folder, this.library); } catch { continue; }
      const walk = async (directory: string) => {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          await this.checkpoint();
          if (item.isSymbolicLink() || /^(Workspaces|outputs|export-review|\.search)$/i.test(item.name)) continue;
          const file = path.join(directory, item.name);
          if (item.isDirectory()) await walk(file);
          else if (item.isFile() && /\.(pdf|docx|pptx|xlsx|md|txt|csv|json|html?|xml|tex|png|jpe?g|webp|gif|bmp)$/i.test(file) && !/\.partial$/.test(file)) files.push({ file, course, relative: path.relative(folder, file).replaceAll("\\", "/") });
        }
      };
      await walk(folder); visitedCourses.add(course.id);
    }
    this.state.completed = 0; this.state.total = files.length; this.saveProgress(); const seen = new Set<string>();
    for (const item of files) {
      await this.checkpoint(); this.state.filename = `${item.course.name} · ${path.basename(item.file)}`; this.publish();
      const id = digest(`${item.course.id}/${item.relative}`).slice(0, 24); seen.add(id);
      try {
        const file = await this.safe(item.file, this.library);
        if ((await stat(file)).size > 250 * 1024 * 1024) throw new Error("File exceeds 250 MB index limit.");
        const bytes = await readFile(file), revision = digest(bytes);
        const existing = this.db.prepare("SELECT * FROM revisions WHERE doc=? AND revision=?").get(id, revision) as { source: string; extracted: string; embedded: number; description_version: string | null } | undefined;
        const destination = path.join(this.root, "content", id, revision);
        await mkdir(destination, { recursive: true });
        const source = path.join(destination, sanitizeFileName(path.basename(file)));
        if (!existing) await writeFile(source, bytes);
        if (existing && (existing.embedded || !this.models.ready) && (!this.descriptions.ready || existing.description_version === DESCRIPTION_VERSION)) {
          this.db.transaction(() => {
            this.db.prepare("UPDATE docs SET archived=?,title=?,revision=? WHERE id=?").run(item.course.isArchived || !item.course.isFavorite ? 1 : 0, path.basename(file), revision, id);
            this.saveFileCheckpoint(item.course, id);
          })();
        } else {
          let extracted = existing ? JSON.parse(existing.extracted) as Awaited<ReturnType<LibraryExtractor["extract"]>> : await this.extractor.extract(source, path.join(destination, "visuals"), this.controller?.signal ?? new AbortController().signal, () => this.checkpoint());
          const rawExtracted = JSON.stringify(extracted);
          const captions = new Map<string, string>();
          let descriptionsComplete = this.descriptions.ready || existing?.description_version === DESCRIPTION_VERSION;
          for (const part of extracted.filter(part => part.image)) {
            await this.checkpoint();
            this.state.filename = `${item.course.name} · ${path.basename(file)} · Describing ${part.location}`; this.publish();
            try {
              const image = await this.safe(part.image!);
              const hash = digest(await readFile(image));
              const cached = this.db.prepare("SELECT description FROM visual_descriptions WHERE image_hash=? AND model=?").get(hash, DESCRIPTION_VERSION) as {description:string} | undefined;
              if (!cached && !this.descriptions.ready) { descriptionsComplete = false; continue; }
              const description = cached?.description ?? await this.descriptions.describe(image, this.controller?.signal ?? new AbortController().signal);
              this.controller?.signal.throwIfAborted();
              // Per-image cache survives cancellation even before a multi-page file finishes.
              if (!cached) this.db.prepare("INSERT OR REPLACE INTO visual_descriptions VALUES (?,?,?)").run(hash, DESCRIPTION_VERSION, description);
              captions.set(part.image!, description);
            } catch (error) {
              this.controller?.signal.throwIfAborted(); descriptionsComplete = false;
              this.state.issues = [...this.state.issues, `${path.basename(file)} ${part.location}: Image description unavailable; OCR/search retained. ${error instanceof Error ? error.message : "Retry indexing."}`].slice(-100);
            }
          }
          extracted = descriptionPassages(extracted, captions);
          if(this.models.ready) {
            const tokenChunks:typeof extracted=[];
            try {
              for(const part of extracted) {await this.checkpoint();if(part.image) tokenChunks.push(part);else for(const text of await this.models.splitText(part.text))tokenChunks.push({...part,text});}
              extracted=tokenChunks;
            } catch (error) {
              this.controller?.signal.throwIfAborted();
              this.models.ready=false;
              this.state.issues.push(`Local tokenizer unavailable; using keyword passages: ${error instanceof Error ? error.message : "model failure"}`);
            }
          }
          const passages: Passage[] = [];
          for (let i = 0; i < extracted.length; i++) {
            await this.checkpoint(); const part = extracted[i];
            let vector: Buffer | null = null;
            if (this.models.ready) {
              try { const values = part.image ? await this.models.visual(part.image, true) : await this.models.text(`${path.basename(file)}\n${part.text}`); vector = Buffer.from(values.buffer, values.byteOffset, values.byteLength); }
              catch { this.models.ready=false;this.state.issues.push("Local embedding runtime unavailable; indexing continues with keyword search. Retry model setup."); }
            }
            passages.push({ id: `${id}:${revision}:${i}`, doc: id, revision, text: part.text, location: part.location, image: part.image ?? null, warning: part.warning ?? null, vector });
          }
          await this.checkpoint();
          this.db.transaction(() => {
            const old = this.db.prepare("SELECT id FROM passages WHERE doc=? AND revision=?").all(id, revision) as Array<{id:string}>;
            for (const p of old) this.db.prepare("DELETE FROM passage_fts WHERE id=?").run(p.id);
            this.db.prepare("DELETE FROM passages WHERE doc=? AND revision=?").run(id, revision);
            for (const p of passages) {
              this.db.prepare("INSERT INTO passages VALUES (@id,@doc,@revision,@text,@location,@image,@warning,@vector)").run(p);
              this.db.prepare("INSERT INTO passage_fts(id,title,text) VALUES (?,?,?)").run(p.id, path.basename(file), p.text);
            }
            this.db.prepare("INSERT OR REPLACE INTO revisions(doc,revision,source,extracted,embedded,description_version) VALUES (?,?,?,?,?,?)").run(id, revision, source, rawExtracted, this.models.ready ? 1 : 0, descriptionsComplete ? DESCRIPTION_VERSION : null);
            this.db.prepare("INSERT OR REPLACE INTO docs VALUES (?,?,?,?,?,?,?,?)").run(id, item.course.id, path.basename(file), item.relative, revision, item.course.isArchived || !item.course.isFavorite ? 1 : 0, "", path.extname(file).slice(1).toLowerCase());
            this.saveFileCheckpoint(item.course, id);
          })(); this.vectors = null; this.docVectors = null;
        }
      } catch (error) { if (this.controller?.signal.aborted) throw error; this.state.issues = [...this.state.issues, `${path.basename(item.file)}: ${error instanceof Error ? error.message : "Indexing failed"}`].slice(-100); }
      this.state.completed++; this.saveProgress(); this.publish();
    }
    await this.checkpoint();
    for (const doc of this.db.prepare("SELECT * FROM docs").all() as Doc[]) if (visitedCourses.has(doc.course) && !seen.has(doc.id)) this.db.prepare("UPDATE docs SET archived=1 WHERE id=?").run(doc.id);
    this.vectors = null; this.docVectors = null;
    await this.buildLinks(inventory);
    this.materialCache.clear();
    this.materialEpoch++;
    this.saveProgress(this.state.completed, false);
  }
  private docs(courses?: string[], archived = false): Doc[] {
    return (this.db.prepare("SELECT * FROM docs").all() as Doc[]).filter(doc => (archived || !doc.archived) && (!courses || courses.includes(doc.course)));
  }
  private hit(p: Passage, doc: Doc, kind: LibraryHit["kind"], score: number): LibraryHit {
    return { id: p.id, documentId: doc.id, revision: p.revision, courseId: doc.course, title: doc.title, location: p.location, snippet: p.text.slice(0, 700), visual: Boolean(p.image), kind, score, warning: p.warning ?? undefined, module: doc.module };
  }
  async assignmentMaterials(assignment: Assignment): Promise<AssignmentMaterials> {
    const epoch = this.materialEpoch;
    const cacheKey = digest(JSON.stringify(assignment));
    const cached = this.materialCache.get(cacheKey); if (cached) return cached;
    const courseDocs = this.docs([assignment.courseId]);
    const byId = new Map(courseDocs.map(doc => [doc.id, doc]));
    const links = this.db.prepare("SELECT source,target,kind FROM links WHERE dismissed=0 AND kind IN ('explicit','membership')").all() as Array<{source:string;target:string;kind:string}>;
    const assignmentNode = `assignment:${assignment.id}`;
    const seeds = new Set(links.filter(link => link.source === assignmentNode && byId.has(link.target)).map(link => link.target));
    for (const attachment of assignment.attachments) if (attachment.localPath) {
      const relative = path.relative(path.join(this.library, sanitizeFileName(assignment.courseName)), attachment.localPath).replaceAll("\\", "/");
      const doc = courseDocs.find(doc => doc.relative === relative); if (doc) seeds.add(doc.id);
    }
    const seedText = [...seeds].slice(0, 8).map(id => {
      const doc = byId.get(id)!;
      return (this.db.prepare("SELECT text FROM passages WHERE doc=? AND revision=? ORDER BY rowid LIMIT 12").all(id, doc.revision) as Array<{text:string}>).map(row => row.text).join(" ");
    }).join(" ").slice(0, 12000);
    const query = assignmentSearchQuery(assignment, seedText);
    const modules = new Set(links.filter(link => link.source.startsWith(`module:${assignment.courseId}:`) && (link.target === assignmentNode || seeds.has(link.target))).map(link => link.source));
    const moduleDocs = new Set(links.filter(link => modules.has(link.source) && byId.has(link.target)).map(link => link.target));
    const ownFolder = (assignment.localFolder ? path.relative(path.join(this.library, sanitizeFileName(assignment.courseName)), assignment.localFolder).replaceAll("\\", "/") : `Assignments/${sanitizeFileName(assignment.title)}`).toLowerCase() + "/";
    const eligible = (doc: Doc) => !seeds.has(doc.id) && !/\.(json|xml)$/i.test(doc.title) && !doc.relative.toLowerCase().startsWith(ownFolder) && !doc.relative.toLowerCase().startsWith(`assignments/${assignment.canvasId}/`);
    const ranked: Array<AssignmentMaterialSuggestion & { rank: number }> = [];
    const terms = new Set(topicTerms(query));
    if (query) {
      const hits = await this.search({ query, courseIds: [assignment.courseId], archived: false, limit: 40 });
      let semanticQuery: Float32Array | undefined;
      if (this.models.ready) { try { semanticQuery = await this.models.text(query); } catch { /* Keep keyword suggestions. */ } }
      const vectors = semanticQuery ? new Map(this.loadVectors().filter(row => !row.image && row.course === assignment.courseId).map(row => [row.id, row.vector])) : null;
      for (const hit of hits) {
        const doc = byId.get(hit.documentId); if (!doc || !eligible(doc)) continue;
        const matching = [...new Set(topicTerms(`${hit.title} ${hit.snippet}`))].filter(term => terms.has(term));
        const vector = vectors?.get(hit.id);
        const similarity = vector && semanticQuery && vector.length === semanticQuery.length ? vector.reduce((sum, value, i) => sum + value * semanticQuery![i], 0) : 0;
        if (!matching.length && similarity < 0.4) continue;
        ranked.push({ hit, reason: matching.length ? `Matches assignment topics: ${matching.slice(0, 3).join(", ")}` : "Similar meaning to the assignment context", rank: hit.score + Math.min(matching.length, 5) * 0.01 + (moduleDocs.has(doc.id) ? 0.03 : 0) });
      }
    }
    for (const id of moduleDocs) {
      const doc = byId.get(id)!; if (!eligible(doc) || ranked.some(item => item.hit.documentId === id)) continue;
      const p = this.db.prepare("SELECT * FROM passages WHERE doc=? AND revision=? ORDER BY rowid LIMIT 1").get(id, doc.revision) as Passage | undefined;
      if (p) ranked.push({ hit: this.hit(p, doc, "keyword", 0), reason: "In the same Canvas module as this assignment or its attachments", rank: 0.01 });
    }
    const documents = new Set<string>();
    const items = ranked.sort((a, b) => b.rank - a.rank).filter(item => { if (documents.has(item.hit.documentId)) return false; documents.add(item.hit.documentId); return true; }).slice(0, 3).map(({hit,reason}) => ({hit,reason}));
    const result = { items, query, indexedDocuments: courseDocs.length };
    if (this.materialCache.size >= 20) this.materialCache.delete(this.materialCache.keys().next().value!);
    if (epoch === this.materialEpoch) this.materialCache.set(cacheKey, result); return result;
  }
  private loadVectors() {
    if (!this.vectors) this.vectors = (this.db.prepare("SELECT p.id,p.vector,p.image,d.course FROM passages p JOIN docs d ON d.id=p.doc WHERE p.vector IS NOT NULL").all() as Array<{id:string;vector:Buffer;image:string|null;course:string}>).map(row => ({ id: row.id, course: row.course, image: !!row.image, vector: new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)) }));
    return this.vectors;
  }
  snapshot(allowed:string[]) { return Object.fromEntries(this.docs(allowed).map(doc=>[doc.id,doc.revision])); }
  async search(query: LibraryQuery, snapshot?:Record<string,string>): Promise<LibraryHit[]> {
    const docs = this.docs(query.courseIds, snapshot ? true : query.archived).filter(doc => !snapshot||snapshot[doc.id]).map(doc=>snapshot?{...doc,revision:snapshot[doc.id]}:doc).filter(doc => (!query.documentId||query.documentId===doc.id) && (!query.fileType || doc.type === query.fileType) && (!query.module || doc.module.toLowerCase().includes(query.module.toLowerCase())));
    const allowed = new Map(docs.map(doc => [doc.id, doc]));
    if(!allowed.size)return [];
    const valid = (id: string) => { const [doc, revision] = id.split(":"); return allowed.get(doc)?.revision === revision; };
    const keyword = ftsQuery(query.query);
    // Populate and consume synchronously before inference yields: concurrent searches cannot mix scopes.
    this.db.transaction(()=>{this.db.prepare("DELETE FROM search_scope").run();const insert=this.db.prepare("INSERT INTO search_scope VALUES (?,?)");for(const doc of docs)insert.run(doc.id,doc.revision);})();
    const filter=" JOIN search_scope scope ON p.doc=scope.doc AND p.revision=scope.revision ";
    const kind=query.kind??"all";
    const rows = (keyword ? this.db.prepare(`SELECT p.id FROM passage_fts JOIN passages p ON p.id=passage_fts.id ${filter} WHERE passage_fts MATCH ? AND (? != 'visual' OR p.image IS NOT NULL) AND (? != 'text' OR p.image IS NULL) ORDER BY passage_fts.rank LIMIT 80`).all(keyword,kind,kind) : this.db.prepare(`SELECT p.id FROM passages p ${filter} WHERE (? != 'visual' OR p.image IS NOT NULL) AND (? != 'text' OR p.image IS NULL) LIMIT 100`).all(kind,kind)) as Array<{id:string}>;
    const rankings = [rows];
    const types = new Map(rankings[0].map(p => [p.id, "keyword" as LibraryHit["kind"]]));
    try {
    if (query.query.trim() && this.models.ready || query.similarTo) {
      const vectors = this.loadVectors().filter(row => valid(row.id));
      if (query.kind !== "visual" && !query.similarTo && this.models.ready) {
        const text = topVectors(await this.models.text(query.query), vectors.filter(row => !row.image), 80);
        rankings.push(text); text.forEach(p => { if (!types.has(p.id)) types.set(p.id, "semantic"); });
      }
      if (query.kind !== "text") {
        let vector: Float32Array;
        if (query.similarTo) {
          const source = vectors.find(row => row.id === query.similarTo && row.image);
          if (!source) throw new Error("Selected diagram is outside the search scope or has no visual embedding.");
          vector = source.vector;
        } else vector = await this.models.visual(query.query, false);
        const visual = topVectors(vector, vectors.filter(row => row.image && row.id !== query.similarTo), 80);
        rankings.push(visual); visual.forEach(p => types.set(p.id, "visual"));
      }
    }
    } catch (error) {
      if (query.similarTo) throw error;
      this.models.ready=false;
      this.state.error="Local model inference failed. Keyword results remain available; retry model setup.";
      this.publish();
    }
    const selected = new Set<string>(); const result: LibraryHit[] = [];
    for (const item of fuse(rankings)) {
      const p = this.passage(item.id), doc = allowed.get(p.doc)!;
      if (query.kind === "text" && p.image) continue;
      const key = `${p.revision}:${p.location}:${!!p.image}`;
      if (selected.has(key)) continue;
      selected.add(key); result.push(this.hit(p, doc, types.get(p.id) ?? "keyword", item.score));
      if (result.length >= (query.limit ?? 30)) break;
    }
    return result;
  }
  private passage(id: string): Passage { const p = this.db.prepare("SELECT * FROM passages WHERE id=?").get(id) as Passage | undefined; if (!p) throw new Error("Source revision unavailable; refresh search."); return p; }
  private authorize(doc: Doc | undefined, allowed?: string[]) { if (!doc || allowed && !allowed.includes(doc.course)) throw new Error("Source is outside the approved courses."); return doc; }
  async preview(id: string, allowed?: string[]): Promise<LibraryPreview> {
    const p = this.passage(id), doc = this.authorize(this.db.prepare("SELECT * FROM docs WHERE id=?").get(p.doc) as Doc, allowed);
    const visual = p.image ?? (this.db.prepare("SELECT image FROM passages WHERE doc=? AND revision=? AND location=? AND image IS NOT NULL LIMIT 1").get(p.doc,p.revision,p.location) as {image:string}|undefined)?.image;
    const imageUrl = visual ? `data:image/png;base64,${(await readFile(await this.safe(visual))).toString("base64")}` : undefined;
    return { hit: this.hit(p, doc, p.image ? "visual" : "keyword", 0), text: p.text, imageUrl, links: this.related(doc.id, allowed) };
  }
  async source(id: string, allowed?: string[]) {
    const p = this.passage(id); this.authorize(this.db.prepare("SELECT * FROM docs WHERE id=?").get(p.doc) as Doc, allowed);
    const revision = this.db.prepare("SELECT source FROM revisions WHERE doc=? AND revision=?").get(p.doc, p.revision) as {source:string};
    return this.safe(revision.source);
  }
  async include(id: string, workspace: string, allowed: string[]) {
    const p = this.passage(id); const source = await this.source(id, allowed);
    if (digest(await readFile(source)) !== p.revision) throw new Error("Source revision integrity check failed. Reindex the original before including it.");
    const destination = path.join(workspace, "materials", "retrieved", p.doc, p.revision);
    // Workspace comes only from the host-created AI run, never a renderer/tool argument.
    await mkdir(destination, { recursive: true });
    await this.safe(destination,this.library);
    const original = path.join(destination, path.basename(source));
    await cp(source, original);
    const all = this.db.prepare("SELECT text,location FROM passages WHERE doc=? AND revision=? AND image IS NULL").all(p.doc, p.revision) as Array<{text:string;location:string}>;
    await writeFile(path.join(destination, "extracted.txt"), all.map(row => `[${row.location}]\n${row.text}`).join("\n\n"));
    return { id, documentId: p.doc, revision: p.revision, path: path.relative(workspace, original).replaceAll("\\", "/"), textPath: path.relative(workspace, path.join(destination, "extracted.txt")).replaceAll("\\", "/"), location: p.location };
  }
  related(id: string, allowed?: string[]): LibraryLink[] {
    const docs = new Set(this.docs(allowed, true).map(doc => doc.id));
    for (const node of this.db.prepare("SELECT id,course FROM nodes").all() as Array<{id:string;course:string}>) if (!allowed || allowed.includes(node.course)) docs.add(node.id);
    if (!docs.has(id)) throw new Error("Source is outside the approved courses.");
    const titles = new Map([...this.docs(allowed,true).map(d=>[d.id,d.title] as const),...(this.db.prepare("SELECT id,title FROM nodes").all() as Array<{id:string;title:string}>).map(n=>[n.id,n.title] as const)]);
    return (this.db.prepare("SELECT * FROM links WHERE source=? OR target=?").all(id,id) as LibraryLink[]).filter(link => docs.has(link.source) && docs.has(link.target)).map(link => ({ ...link, pinned: !!link.pinned, dismissed: !!link.dismissed,sourceTitle:titles.get(link.source),targetTitle:titles.get(link.target) }));
  }
  link(source: string, target: string, kind: LinkKind, action: "pin" | "dismiss" | "restore") {
    const exists = (id: string) => this.db.prepare("SELECT id FROM docs WHERE id=? UNION SELECT id FROM nodes WHERE id=?").get(id,id);
    if (!exists(source) || !exists(target) || source === target) throw new Error("Choose two different indexed documents.");
    const id = digest(`${source}:${target}:${kind}`);
    if (kind !== "manual" && !this.db.prepare("SELECT id FROM links WHERE id=?").get(id)) throw new Error("Relationship is no longer available.");
    this.db.prepare("INSERT INTO links VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET pinned=excluded.pinned,dismissed=excluded.dismissed").run(id,source,target,kind,"User-created link",action === "pin" ? 1 : 0,action === "dismiss" ? 1 : 0);
  }
  graph(input: { courseIds?: string[]; expanded?: string[]; focus?: string; archived?: boolean }): LibraryGraph {
    const docs = this.docs(input.courseIds,input.archived);
    const allNodes = this.db.prepare("SELECT id,course AS courseId,title,kind FROM nodes").all() as LibraryGraph["nodes"];
    const courses = allNodes.filter(n => n.kind === "course" && (!input.courseIds || input.courseIds.includes(n.courseId)));
    const expand = new Set(input.expanded ?? []);
    if (input.focus) { const doc = docs.find(d => d.id === input.focus); if (doc) expand.add(doc.course); }
    const nodes: LibraryGraph["nodes"] = courses.map(c => ({ ...c, count: docs.filter(d => d.course === c.courseId).length }));
    nodes.push(...allNodes.filter(n => n.kind !== "course" && expand.has(n.courseId) && (!input.courseIds || input.courseIds.includes(n.courseId))));
    nodes.push(...docs.filter(d => expand.has(d.course)).sort((a,b) => Number(b.id === input.focus)-Number(a.id === input.focus)).slice(0,800).map(d => ({ id:d.id,title:d.title,courseId:d.course,kind:"document" as const })));
    const ids = new Set(nodes.map(n => n.id));
    const links = (this.db.prepare("SELECT * FROM links WHERE dismissed=0").all() as LibraryLink[]).filter(l => ids.has(l.source) && ids.has(l.target)).map(l => ({ ...l,pinned:!!l.pinned,dismissed:!!l.dismissed }));
    return { nodes,links,truncated:docs.filter(d => expand.has(d.course)).length > 800 };
  }
  private edge(source: string,target: string,kind: LinkKind,reason: string) {
    if (source === target) return;
    this.db.prepare("INSERT INTO links VALUES (?,?,?,?,?,0,0) ON CONFLICT(id) DO UPDATE SET reason=excluded.reason").run(digest(`${source}:${target}:${kind}`),source,target,kind,reason);
  }
  private async buildLinks(inventory: LibraryInventory) {
    this.db.prepare("DELETE FROM links WHERE kind IN ('explicit','membership') AND pinned=0 AND dismissed=0").run();
    const docs = this.docs(undefined,true);
    for (const course of inventory.courses) {
      this.db.prepare("INSERT OR REPLACE INTO nodes VALUES (?,?,?,?)").run(`course:${course.id}`,course.id,course.name,"course");
      const courseDocs = docs.filter(d => d.course === course.id);
      for (const doc of courseDocs) this.edge(`course:${course.id}`,doc.id,"membership","Downloaded course material");
      // Resolve source-authored hyperlinks only against already-downloaded, same-course identities.
      for (const doc of courseDocs.filter(d=>["md","html","htm"].includes(d.type))) {
        await this.checkpoint();
        const revision=this.db.prepare("SELECT source FROM revisions WHERE doc=? AND revision=?").get(doc.id,doc.revision) as {source:string}|undefined;
        if(!revision)continue;
        try {
          const body=await readFile(await this.safe(revision.source),"utf8");
          const references=[...body.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']|\]\(([^)\s]+)(?:\s+[^)]*)?\)/gi)].map(match=>match[1]??match[2]);
          for(const reference of references) {
            let decoded:string;try{decoded=decodeURIComponent(reference.replaceAll("&amp;","&"));}catch{continue;}
            const canvas=decoded.match(/\/courses\/(\d+)\/files\/(\d+)/);
            if(canvas&&canvas[1]!==String(course.canvasId))continue;
            const fileId=canvas?.[2]??(!/\/courses\//.test(decoded)?decoded.match(/\/files\/(\d+)/)?.[1]:undefined);
            const relative=path.posix.normalize(path.posix.join(path.posix.dirname(doc.relative),decoded.split(/[?#]/)[0]));
            for(const target of courseDocs.filter(d=>fileId?d.relative.startsWith(`files/${fileId}/Attachments/`):d.relative===relative))this.edge(doc.id,target.id,"explicit",`Source hyperlink in ${doc.title}`);
          }
        }catch{this.state.issues.push(`Could not resolve local links in ${doc.title}`);}
      }
      for (const assignment of inventory.assignments.filter(a => a.courseId === course.id)) {
        const aid = `assignment:${assignment.id}`;
        this.db.prepare("INSERT OR REPLACE INTO nodes VALUES (?,?,?,?)").run(aid,course.id,assignment.title,"assignment");
        this.edge(`course:${course.id}`,aid,"membership","Canvas assignment");
        for (const attachment of assignment.attachments) {
          const relative = attachment.localPath ? path.relative(path.join(this.library,sanitizeFileName(course.name)),attachment.localPath).replaceAll("\\","/") : "";
          const target = courseDocs.find(d => d.relative === relative);
          if (target) this.edge(aid,target.id,"explicit","Canvas assignment attachment or description link");
        }
      }
      const moduleDoc = courseDocs.find(d => d.relative === "modules/index.json");
      if (moduleDoc) {
        try {
          const rev = this.db.prepare("SELECT source FROM revisions WHERE doc=? AND revision=?").get(moduleDoc.id,moduleDoc.revision) as {source:string};
          const modules = JSON.parse(await readFile(rev.source,"utf8")) as Array<{ id: number; name: string; items?: Array<{ content_id?: number; type?: string; page_url?: string }> }>;
          for (const module of modules) {
            const mid = `module:${course.id}:${module.id}`;
            this.db.prepare("INSERT OR REPLACE INTO nodes VALUES (?,?,?,?)").run(mid,course.id,module.name,"module");
            this.edge(`course:${course.id}`,mid,"membership","Canvas module");
            for (const item of module.items ?? []) {
              if(item.type==="Assignment"&&item.content_id) {
                const assignment=inventory.assignments.find(a=>a.courseId===course.id&&String(a.canvasId)===String(item.content_id));
                if(assignment)this.edge(mid,`assignment:${assignment.id}`,"membership",`Included in ${module.name}`);
              }
              for (const doc of courseDocs) {
              if (item.content_id && doc.relative.includes(`/${item.content_id}/`) || item.page_url && doc.relative.includes(item.page_url)) {
                this.edge(mid,doc.id,"membership",`Included in ${module.name}`);
                this.db.prepare("UPDATE docs SET module=? WHERE id=?").run(module.name,doc.id);
              }
              }
            }
          }
        } catch { this.state.issues.push("Some Canvas module relationships could not be read."); }
      }
    }
    if (this.models.ready) for (const doc of this.docs()) { await this.checkpoint(); await this.suggest(doc.id); }
  }
  async suggest(documentId: string, allowed?: string[]) {
    const doc = this.authorize(this.db.prepare("SELECT * FROM docs WHERE id=?").get(documentId) as Doc,allowed);
    if (!this.docVectors) {
      const current = new Map(this.docs().map(d=>[d.id,d.revision]));
      const sums = new Map<string,{id:string;course:string;image:boolean;vector:Float32Array}>();
      for (const row of this.loadVectors()) {
        const [id,revision]=row.id.split(":"); if(current.get(id)!==revision) continue;
        const key=`${id}:${row.image}`; let sum=sums.get(key);
        if(!sum) {sum={id,course:row.course,image:row.image,vector:new Float32Array(row.vector.length)};sums.set(key,sum);}
        for(let i=0;i<sum.vector.length;i++) sum.vector[i]+=row.vector[i];
      }
      this.docVectors=[...sums.values()].map(row=>({...row,vector:normalize(row.vector)}));
    }
    // Suggestions belong to the library; scope only the returned view, never rewrite global links to a narrower scope.
    const vectors=this.docVectors;
    this.db.prepare("DELETE FROM links WHERE source=? AND kind IN ('semantic','visual') AND pinned=0 AND dismissed=0").run(doc.id);
    for (const visual of [false,true]) {
      const seed = vectors.find(v => v.id===doc.id && v.image === visual); if (!seed) continue;
      const neighbors = topVectors(seed.vector,vectors.filter(v => v.image === visual && v.id!==doc.id),80);
      const linked = new Set<string>();
      for (const n of neighbors) { const target = n.id.split(":")[0]; if (n.score < (visual ? 0.8 : 0.55) || linked.has(target)) continue; linked.add(target); this.edge(doc.id,target,visual ? "visual":"semantic",`Suggested ${visual ? "image":"passage"} similarity; compare source locations. Not a Canvas requirement.`); if (linked.size === 5) break; }
    }
    return this.related(documentId,allowed);
  }
  async close() { this.controller?.abort(); this.resume?.(); await this.extractor.close(); this.db?.close(); }
}
