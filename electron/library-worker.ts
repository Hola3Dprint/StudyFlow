import { parentPort, workerData } from "node:worker_threads";
import { LibraryEngine } from "./services/library-engine";
import type { LibraryInventory } from "./services/library-engine";
import type { LibraryQuery, LinkKind } from "../shared/library";
const port = parentPort!;
const engine = new LibraryEngine(workerData.root, workerData.library, state => port.postMessage({ status: state }));
const ready = engine.init();
let inventory: LibraryInventory = { courses: [], assignments: [] };
port.on("message", async ({ id, method, input }) => {
  try {
    await ready;
    let result: unknown;
    switch (method) {
      case "inventory": inventory = input; result = engine.start(inventory); break;
      case "status": result = engine.state; break;
      case "control": result = input === "index" || input === "setup" ? engine.start(inventory, input === "setup") : engine.control(input); break;
      case "setup-descriptions": result = engine.start(inventory, "descriptions"); break;
      case "search": result = await engine.search(input as LibraryQuery); break;
      case "assignment-materials": result = await engine.assignmentMaterials(input); break;
      case "snapshot": result = engine.snapshot(input); break;
      case "scoped-search": result = await engine.search(input.query,input.snapshot); break;
      case "preview": result = await engine.preview(input.id,input.allowed); break;
      case "source": result = await engine.source(input.id,input.allowed); break;
      case "include": result = await engine.include(input.id,input.workspace,input.allowed); break;
      case "related": result = await engine.suggest(input.id,input.allowed); break;
      case "graph": result = engine.graph(input); break;
      case "link": result = engine.link(input.source,input.target,input.kind as LinkKind,input.action); break;
      default: throw new Error("Unknown library operation.");
    }
    port.postMessage({ id, result });
  } catch (error) { port.postMessage({ id,error: error instanceof Error ? error.message : "Library request failed." }); }
});
