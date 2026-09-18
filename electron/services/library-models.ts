import { mkdir, readFile, writeFile, rename, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalize } from "./library-core";

export interface LocalModelSpec { id: string; revision: string; files: readonly string[]; maxAssetBytes?: number }
const MODELS: readonly LocalModelSpec[] = [
  { id: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9", files: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt", "onnx/model_quantized.onnx"] },
  { id: "Xenova/clip-vit-base-patch32", revision: "d15189d7028b43f1d3e65039190477f6af591c2a", files: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "preprocessor_config.json", "vocab.json", "merges.txt", "onnx/text_model_quantized.onnx", "onnx/vision_model_quantized.onnx"] },
] as const;
type Transformers = typeof import("@huggingface/transformers");
type Progress = (filename: string, received: number, total: number) => void;
interface ManifestEntry { file: string; hash: string }
export class LibraryModels {
  private runtime?: Transformers;
  private textPipeline?: Awaited<ReturnType<Transformers["pipeline"]>>;
  private tokenizer?: Awaited<ReturnType<Transformers["AutoTokenizer"]["from_pretrained"]>>;
  private passageTokenizer?: Awaited<ReturnType<Transformers["AutoTokenizer"]["from_pretrained"]>>;
  private processor?: Awaited<ReturnType<Transformers["AutoProcessor"]["from_pretrained"]>>;
  private textModel?: Awaited<ReturnType<Transformers["CLIPTextModelWithProjection"]["from_pretrained"]>>;
  private visionModel?: Awaited<ReturnType<Transformers["CLIPVisionModelWithProjection"]["from_pretrained"]>>;
  ready = false;
  constructor(readonly root: string, private readonly definitions = MODELS, private readonly manifestFile = "verified.json") {}
  private folder(index: number) { return path.join(this.root, this.definitions[index].revision); }
  async verify(): Promise<boolean> {
    this.ready = false;
    try {
      const manifest: ManifestEntry[] = JSON.parse(await readFile(path.join(this.root, this.manifestFile), "utf8"));
      const expected = this.definitions.flatMap(model => model.files.map(file => `${model.revision}/${file}`));
      if (manifest.length !== expected.length || !expected.every(file => manifest.some(item => item.file === file))) return false;
      for (const item of manifest) if (createHash("sha256").update(await readFile(path.join(this.root, item.file))).digest("hex") !== item.hash) return false;
      this.ready = true;
    } catch { /* Keyword search stays available. */ }
    return this.ready;
  }
  async setup(signal: AbortSignal, progress: Progress, checkpoint:()=>Promise<void> = async()=>{}) {
    signal.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < 2 * 1024 * 1024 * 1024) throw new Error("At least 2 GB of free disk space is required for local model setup.");
    const manifest: ManifestEntry[] = [];
    for (const model of this.definitions) {
      const response = await fetch(`https://huggingface.co/api/models/${model.id}/revision/${model.revision}?blobs=true`, { signal });
      if (!response.ok) throw new Error(`Model metadata unavailable (${response.status}). Retry setup when online.`);
      const metadata = await response.json() as { sha: string; siblings: Array<{ rfilename: string; size: number; blobId: string; lfs?: { sha256: string } }> };
      if (metadata.sha !== model.revision) throw new Error("Model revision mismatch.");
      for (const file of model.files) {
        await checkpoint();
        signal.throwIfAborted();
        const record = metadata.siblings.find(item => item.rfilename === file);
        if (!record || record.size > (model.maxAssetBytes ?? 200 * 1024 * 1024)) throw new Error("Unexpected model asset.");
        const target = path.join(this.root, model.revision, file);
        await mkdir(path.dirname(target), { recursive: true });
        let bytes: Buffer | undefined;
        try { if ((await stat(target)).size === record.size) bytes = await readFile(target); } catch { /* download */ }
        const valid = (data: Buffer) => record.lfs ? createHash("sha256").update(data).digest("hex") === record.lfs.sha256 : createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") === record.blobId;
        if (!bytes || !valid(bytes)) {
          const asset = await fetch(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`, { signal });
          if (!asset.ok || !asset.body) throw new Error(`Cannot download ${file}: HTTP ${asset.status}`);
          const buffers: Uint8Array[] = []; let received = 0;
          for await (const chunk of asset.body) {
            await checkpoint();
            signal.throwIfAborted(); received += chunk.length;
            if (received > record.size) throw new Error("Model download exceeded its declared size.");
            buffers.push(chunk); progress(file, received, record.size);
          }
          bytes = Buffer.concat(buffers);
          if (bytes.length !== record.size || !valid(bytes)) throw new Error(`Integrity check failed for ${file}. Retry setup.`);
          await writeFile(`${target}.partial`, bytes); await rename(`${target}.partial`, target);
        }
        manifest.push({ file: `${model.revision}/${file}`, hash: createHash("sha256").update(bytes).digest("hex") });
      }
    }
    await writeFile(path.join(this.root, this.manifestFile), JSON.stringify(manifest));
    this.ready = true;
  }
  private async load() {
    if (!this.ready) throw new Error("Local search models are not installed or failed integrity verification.");
    if (!this.runtime) {
      this.runtime = await import("@huggingface/transformers");
      this.runtime.env.allowRemoteModels = false;
      this.runtime.env.allowLocalModels = true;
      if (this.runtime.env.backends.onnx.wasm) this.runtime.env.backends.onnx.wasm.numThreads = 1;
    }
    return this.runtime;
  }
  async text(value: string): Promise<Float32Array> {
    const runtime = await this.load();
    this.textPipeline ??= await runtime.pipeline("feature-extraction", this.folder(0), { dtype: "q8", device: "cpu" });
    // Runtime pipeline is the feature-extraction callable selected above.
    const output = await (this.textPipeline as import("@huggingface/transformers").FeatureExtractionPipeline)(value, { pooling: "mean", normalize: true });
    return normalize(output.data as Float32Array);
  }
  async splitText(text:string):Promise<string[]> {
    const runtime=await this.load();
    this.passageTokenizer ??= await runtime.AutoTokenizer.from_pretrained(this.folder(0));
    const count=(value:string)=>this.passageTokenizer!.encode(value,{add_special_tokens:false}).length;
    const words=text.match(/\S+/g)??[];const result:string[]=[];
    for(let start=0;start<words.length;) {
      let end=start+1;
      while(end<words.length && count(words.slice(start,end+1).join(" "))<=220)end++;
      result.push(words.slice(start,end).join(" "));
      if(end===words.length)break;
      let overlap=end;
      while(overlap>start+1 && count(words.slice(overlap-1,end).join(" "))<=40)overlap--;
      start=Math.max(start+1,overlap);
    }
    return result;
  }
  async visual(value: string, image: boolean): Promise<Float32Array> {
    const runtime = await this.load();
    if (image) {
      this.processor ??= await runtime.AutoProcessor.from_pretrained(this.folder(1));
      this.visionModel ??= await runtime.CLIPVisionModelWithProjection.from_pretrained(this.folder(1), { dtype: "q8", device: "cpu" });
      const inputs = await this.processor(await runtime.RawImage.read(value));
      const output = await this.visionModel(inputs);
      return normalize(output.image_embeds.data);
    }
    this.tokenizer ??= await runtime.AutoTokenizer.from_pretrained(this.folder(1));
    this.textModel ??= await runtime.CLIPTextModelWithProjection.from_pretrained(this.folder(1), { dtype: "q8", device: "cpu" });
    const output = await this.textModel(await this.tokenizer(value, { padding: true, truncation: true }));
    return normalize(output.text_embeds.data);
  }
}
