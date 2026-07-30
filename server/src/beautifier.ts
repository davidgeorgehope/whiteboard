import fs from "node:fs/promises";
import path from "node:path";
import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";

const WORK_DIR = path.resolve(import.meta.dirname, "../.board-workspace");
const RUN_TIMEOUT_MS = 300_000;

// Hybrid pipeline: the agent first transcribes the handwriting (a vision LLM
// reads far more reliably than an image model), then drives its image
// generation tool with a spec that pins every word's spelling. Direct
// photo->image generation looked great but mangled most of the text.
const RULES = `You convert a camera snapshot of a hand-drawn paper "whiteboard" into a polished digital whiteboard image.

For every snapshot, follow this exact workflow:
1. Transcribe ALL handwritten text as plain text, one line per line of writing. Read letter by letter; do not substitute a word that merely fits the context. Spell out every label, including vertical, rotated, or boxed ones. Read the attached image directly in a single pass: the snapshot is already high-resolution and pre-cleaned, so do NOT run scripts, crop, rotate, or upscale it first - that costs minutes and does not improve accuracy.
2. Write a compact rendering spec: every text element with its exact spelling and position, every shape, curve, arrow, table, stick figure and doodle, what connects to what, ink colors, white background.
3. Render the spec with your image generation tool: clean typed sans-serif lettering, smooth vector-like strokes, consistent line weight, dark ink on pure white, in the style of a polished Excalidraw diagram. Explicitly set the image generation tool's aspect_ratio parameter to "4:3" (the paper is US Letter landscape, 1.29:1; the tool otherwise defaults to 3:2 which squeezes the layout). Pass the snapshot file as a reference image so the layout matches. Every word in the image must be spelled exactly as in your transcription. Call the image generation tool exactly ONCE: do not inspect, review, or regenerate the result - each render costs ~50 seconds and the first one is final.

Rules:
- Preserve the author's wording, spatial layout, relative sizes, and pen colors. Do not invent content that is not on the board.
- Save the generated image to the exact output path given in the message. Once it is saved, reply with exactly DONE - no review, no summary; the file is picked up automatically the moment you finish.
- If the snapshot is not a written page at all (an object covering the board, a wrong camera view, a blur), do NOT generate anything; reply with exactly SKIP.`;

export interface BeautifyResult {
  /** PNG as base64 (no data-url prefix). */
  png: string;
  durationMs: number;
}

export class Beautifier {
  private modelId: string | null = null;
  private passCounter = 0;
  private lastPng: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private latestRequest = 0;
  private cancelCurrent: (() => void) | null = null;
  public lastError: string | null = null;

  constructor(private apiKey: string) {}

  get model(): string | null {
    return this.modelId;
  }

  async pickModel(): Promise<string> {
    if (this.modelId) return this.modelId;
    if (process.env.CURSOR_MODEL) {
      this.modelId = process.env.CURSOR_MODEL;
      return this.modelId;
    }
    try {
      const models = await Cursor.models.list({ apiKey: this.apiKey });
      const ids = models.map((m) => m.id);
      // The agent needs vision for the transcription step. A 7-model
      // comparison on a real dense board (2026-07): opus-4-8 read the
      // handwriting most reliably and fastest; gpt misread in every trial;
      // opus-5 burns its budget thinking, so match 4-8 exactly. Fable reads
      // blurry input best - switch to it if the camera rig degrades.
      const preferred =
        ids.find((id) => /opus-4-8/i.test(id)) ??
        ids.find((id) => /fable/i.test(id)) ??
        ids.find((id) => /sonnet/i.test(id)) ??
        ids.find((id) => /gpt/i.test(id)) ??
        ids.find((id) => /gemini/i.test(id));
      this.modelId = preferred ?? "auto";
    } catch {
      this.modelId = "auto";
    }
    return this.modelId;
  }

  // One agent per pass, thrown away afterwards. A persistent agent saved the
  // ~2s creation cost but its growing conversation history made every later
  // pass slower and tool-happier (118s to reach image generation vs 32s on a
  // fresh agent, measured 2026-07-30).
  private async createAgent(): Promise<SDKAgent> {
    await fs.mkdir(WORK_DIR, { recursive: true });
    const model = await this.pickModel();
    return Agent.create({
      apiKey: this.apiKey,
      model: { id: model },
      name: "Whiteboard beautifier",
      local: { cwd: WORK_DIR },
    });
  }

  /**
   * Serialized with a newest-wins policy. Only one run executes at a time,
   * and a new request cancels the in-flight run rather than queueing behind
   * it: the client only sends a new snapshot when the running pass's input is
   * already stale, and client-side fetch aborts are not guaranteed to reach
   * us through the dev proxy, so a zombie run could otherwise hold the agent
   * for minutes.
   */
  beautify(pngBase64: string, isAbandoned?: () => boolean): Promise<BeautifyResult> {
    const requestId = ++this.latestRequest;
    this.cancelCurrent?.();
    const task = () => {
      if (isAbandoned?.()) throw new Error("request abandoned before its turn");
      if (requestId !== this.latestRequest) throw new Error("superseded by a newer request");
      return this.runOnce(pngBase64, isAbandoned);
    };
    const result = this.chain.then(task, task);
    this.chain = result.catch(() => {});
    return result;
  }

  private async runOnce(pngBase64: string, isAbandoned?: () => boolean): Promise<BeautifyResult> {
    const started = Date.now();
    const passId = ++this.passCounter;
    const snapshotPath = path.join(WORK_DIR, `snapshot-${passId}.png`);
    const outputName = `board-${passId}.png`;
    const outputPath = path.join(WORK_DIR, outputName);
    let agent: SDKAgent | null = null;
    try {
      agent = await this.createAgent();
      await fs.writeFile(snapshotPath, Buffer.from(pngBase64, "base64"));

      const prompt = `${RULES}\n\nThe snapshot is attached and also saved at ${snapshotPath} (use that path as the image tool's reference image). Save the generated whiteboard image to exactly ${outputPath}`;

      const run = await agent.send({
        text: prompt,
        images: [{ data: pngBase64, mimeType: "image/png" }],
      });
      this.cancelCurrent = () => {
        console.log(`[pass ${passId}] cancelled: superseded by a newer request`);
        run.cancel().catch(() => {});
      };

      const timeout = setTimeout(() => {
        run.cancel().catch(() => {});
      }, RUN_TIMEOUT_MS);
      // Nobody is waiting for an abandoned request's render (page reloaded);
      // cancel mid-run instead of holding the agent for minutes.
      const abandonPoll = isAbandoned
        ? setInterval(() => {
            if (isAbandoned()) run.cancel().catch(() => {});
          }, 5000)
        : null;

      let text = "";
      // Stage log: one line per event, so "refreshing…" is attributable to
      // transcription (text), the image tool, or dead air.
      const t = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
      console.log(`[pass ${passId}] ${t()}s send at ${new Date().toLocaleTimeString()}`);
      try {
        for await (const event of run.stream()) {
          if (event.type === "assistant") {
            let chars = 0;
            for (const block of event.message.content) {
              if (block.type === "text") {
                text += block.text;
                chars += block.text.length;
              } else {
                console.log(`[pass ${passId}] ${t()}s assistant block: ${block.type}`);
              }
            }
            if (chars) console.log(`[pass ${passId}] ${t()}s text +${chars} chars`);
          } else if (event.type === "tool_call") {
            console.log(`[pass ${passId}] ${t()}s tool ${event.name} ${event.status}`);
          } else if (event.type !== "thinking") {
            console.log(`[pass ${passId}] ${t()}s event: ${event.type}`);
          }
        }
        const result = await run.wait();
        if (result.status !== "finished") {
          throw new Error(
            `agent run ${result.status}: ${result.error?.message ?? "no details"} (run ${result.id})`,
          );
        }
        if (!text && result.result) text = result.result;
      } finally {
        this.cancelCurrent = null;
        clearTimeout(timeout);
        if (abandonPoll) clearInterval(abandonPoll);
      }

      if (/\bSKIP\b/.test(text) && this.lastPng) {
        return { png: this.lastPng, durationMs: Date.now() - started };
      }

      const png = await this.readGeneratedImage(outputPath, outputName);
      this.lastError = null;
      this.lastPng = png;
      return { png, durationMs: Date.now() - started };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (agent) void agent[Symbol.asyncDispose]().catch(() => {});
      await fs.rm(snapshotPath, { force: true });
      await fs.rm(outputPath, { force: true });
    }
  }

  /**
   * The image tool has been observed saving relative to the server process
   * cwd instead of the agent cwd, so check both before giving up.
   */
  private async readGeneratedImage(outputPath: string, outputName: string): Promise<string> {
    const candidates = [outputPath, path.resolve(process.cwd(), outputName)];
    for (const file of candidates) {
      try {
        const buf = await fs.readFile(file);
        await fs.rm(file, { force: true });
        return buf.toString("base64");
      } catch {
        // try next location
      }
    }
    throw new Error("agent finished but produced no image file");
  }

  /**
   * New board session. Agents are per-pass now, so the only cross-pass state
   * is the cached image that SKIP falls back to; a new page must not inherit
   * the previous page's render.
   */
  async reset(): Promise<void> {
    this.lastPng = null;
  }

  async dispose(): Promise<void> {
    // Per-pass agents are disposed by runOnce; nothing persistent to tear down.
  }
}
