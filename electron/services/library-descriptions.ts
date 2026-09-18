import path from "node:path";
import { LibraryModels, type LocalModelSpec } from "./library-models";
import type { ExtractedPassage } from "./library-extract";

export const DESCRIPTION_MODEL: LocalModelSpec = {
  id: "onnx-community/Florence-2-base-ft", revision: "e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f", maxAssetBytes: 400 * 1024 * 1024,
  files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "vocab.json", "merges.txt", "onnx/embed_tokens.onnx", "onnx/vision_encoder.onnx", "onnx/encoder_model_q4.onnx", "onnx/decoder_model_merged_q4.onnx"],
};
export const DESCRIPTION_VERSION = `${DESCRIPTION_MODEL.revision}:detailed-v1`;
export const DESCRIPTION_WARNING = "AI-generated visual description, not verified source text. May misidentify objects, arrows, dimensions or boundary conditions. Inspect the original image before using it.";

export function descriptionPassages(parts: ExtractedPassage[], descriptions: Map<string, string>): ExtractedPassage[] {
  return parts.flatMap(part => {
    const description = part.image ? descriptions.get(part.image) : undefined;
    if (!description) return [part];
    const text = `AI visual description (unverified): ${description}`;
    const warning = [DESCRIPTION_WARNING, part.warning].filter(Boolean).join(" ");
    // The image retains its CLIP vector; the companion passage gets a text vector.
    // Matching locations let both results preview the same original image.
    return [{ ...part, text: `${text}\n\nSource text / OCR:\n${part.text}`, warning }, { text, location: part.location, warning }];
  });
}
export class LibraryDescriptions {
  readonly assets: LibraryModels;
  private model?: import("@huggingface/transformers").Florence2ForConditionalGeneration;
  private processor?: import("@huggingface/transformers").Florence2Processor;
  private tokenizer?: import("@huggingface/transformers").PreTrainedTokenizer;
  constructor(readonly root: string) { this.assets = new LibraryModels(root, [DESCRIPTION_MODEL], "captions-verified.json"); }
  get ready() { return this.assets.ready; }
  async describe(file: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!this.ready) throw new Error("Local image-description model is not installed.");
    const runtime = await import("@huggingface/transformers");
    runtime.env.allowRemoteModels = false; runtime.env.allowLocalModels = true;
    const folder = path.join(this.root, DESCRIPTION_MODEL.revision);
    this.model ??= await runtime.Florence2ForConditionalGeneration.from_pretrained(folder, { device: "cpu", dtype: { embed_tokens: "fp32", vision_encoder: "fp32", encoder_model: "q4", decoder_model_merged: "q4" }, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } }) as import("@huggingface/transformers").Florence2ForConditionalGeneration;
    this.processor ??= await runtime.AutoProcessor.from_pretrained(folder) as import("@huggingface/transformers").Florence2Processor;
    this.tokenizer ??= await runtime.AutoTokenizer.from_pretrained(folder);
    signal.throwIfAborted();
    const image = await runtime.RawImage.read(file);
    const task = "<MORE_DETAILED_CAPTION>";
    const inputs = { ...await this.processor(image), ...await this.tokenizer(this.processor.construct_prompts(task)) };
    const stop = new runtime.InterruptableStoppingCriteria();
    const criteria = new runtime.StoppingCriteriaList(); criteria.push(stop);
    const abort = () => stop.interrupt(); signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const ids = await this.model.generate({ ...inputs, max_new_tokens: 160, num_beams: 1, do_sample: false, stopping_criteria: criteria });
      signal.throwIfAborted();
      const decoded = this.tokenizer.batch_decode(ids as import("@huggingface/transformers").Tensor, { skip_special_tokens: false })[0];
      const result = this.processor.post_process_generation(decoded, task, image.size)[task];
      if (typeof result !== "string" || !result.trim()) throw new Error("The local model returned no image description.");
      return result.replace(/\s+/g, " ").trim().slice(0, 4000);
    } finally { signal.removeEventListener("abort", abort); }
  }
}
