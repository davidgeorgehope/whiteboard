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
3. Render the spec with your image generation tool: clean typed sans-serif lettering, smooth vector-like strokes, consistent line weight, dark ink on pure white, in the style of a polished Excalidraw diagram. Explicitly set the image generation tool's aspect_ratio parameter to "4:3" (the paper is US Letter landscape, 1.29:1; the tool otherwise defaults to 3:2 which squeezes the layout). Pass the snapshot file as a reference image so the layout matches. Every word in the image must be spelled exactly as in your transcription.

Rules:
- Preserve the author's wording, spatial layout, relative sizes, and pen colors. Do not invent content that is not on the board.
- Save the generated image to the exact output path given in the message.
- If the snapshot is not a written page at all (an object covering the board, a wrong camera view, a blur), do NOT generate anything; reply with exactly SKIP.`;

export interface BeautifyResult {
  /** PNG as base64 (no data-url prefix). */
  png: string;
  durationMs: number;
}

export class Beautifier {
  private agentPromise: Promise<SDKAgent> | null = null;
  private modelId: string | null = null;
  private firstPass = true;
  private passCounter = 0;
  private lastPng: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  public lastError: string | null = null;

  constructor(private apiKey: string) {}

  get model(): string | null {
    return this.modelId;
  }

  get ready(): boolean {
    return this.agentPromise !== null;
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

  private async getAgent(): Promise<SDKAgent> {
    if (!this.agentPromise) {
      this.agentPromise = (async () => {
        await fs.mkdir(WORK_DIR, { recursive: true });
        const model = await this.pickModel();
        return Agent.create({
          apiKey: this.apiKey,
          model: { id: model },
          name: "Whiteboard beautifier",
          local: { cwd: WORK_DIR },
        });
      })();
      this.agentPromise.catch(() => {
        this.agentPromise = null;
        this.firstPass = true;
      });
    }
    return this.agentPromise;
  }

  /**
   * Serialized: the persistent agent can only process one run at a time.
   * `isAbandoned` is checked when the queued run's turn comes: a page reload
   * kills the fetch but not the queued work, and each orphaned pass would
   * otherwise hold the agent for minutes.
   */
  beautify(pngBase64: string, isAbandoned?: () => boolean): Promise<BeautifyResult> {
    const task = () => {
      if (isAbandoned?.()) throw new Error("request abandoned before its turn");
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
    try {
      const agent = await this.getAgent();
      await fs.writeFile(snapshotPath, Buffer.from(pngBase64, "base64"));

      const preamble = this.firstPass ? `${RULES}\n\n` : "The board has changed; process the fresh snapshot with the same workflow and rules. ";
      const prompt = `${preamble}The snapshot is attached and also saved at ${snapshotPath} (use that path as the image tool's reference image). Save the generated whiteboard image to exactly ${outputPath}`;

      const run = await agent.send({
        text: prompt,
        images: [{ data: pngBase64, mimeType: "image/png" }],
      });

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
      try {
        for await (const event of run.stream()) {
          if (event.type === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "text") text += block.text;
            }
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
        clearTimeout(timeout);
        if (abandonPoll) clearInterval(abandonPoll);
      }

      if (/\bSKIP\b/.test(text) && this.lastPng) {
        return { png: this.lastPng, durationMs: Date.now() - started };
      }

      const png = await this.readGeneratedImage(outputPath, outputName);
      this.firstPass = false;
      this.lastError = null;
      this.lastPng = png;
      return { png, durationMs: Date.now() - started };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // A failed run can leave the persistent conversation in a state where
      // every follow-up also fails; start over with a fresh agent next time.
      await this.reset();
      throw err;
    } finally {
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

  async reset(): Promise<void> {
    const stale = this.agentPromise;
    this.agentPromise = null;
    this.firstPass = true;
    this.lastPng = null;
    if (stale) {
      try {
        const agent = await stale;
        await agent[Symbol.asyncDispose]();
      } catch {
        // agent may have never been created
      }
    }
  }

  async dispose(): Promise<void> {
    const promise = this.agentPromise;
    this.agentPromise = null;
    if (promise) {
      try {
        const agent = await promise;
        await agent[Symbol.asyncDispose]();
      } catch {
        // best-effort cleanup on shutdown
      }
    }
  }
}
