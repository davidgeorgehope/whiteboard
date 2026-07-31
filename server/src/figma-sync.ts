import path from "node:path";
import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";

// Generous: a full board redraw is read + transcription + several use_figma
// calls with thinking in between. The sync never blocks the UI, so latency
// only delays the mirror - but a cancelled run leaves a half-drawn board.
const RUN_TIMEOUT_MS = 600_000;

// Figma's remote MCP rejects PATs and only accepts OAuth from approved clients,
// so the server is declared in ~/.cursor/mcp.json and authenticated once via
// `cursor-agent mcp login figma`. Tokens land in the per-project store
// (~/.cursor/projects/<slug>/mcp-auth.json), which the agent runtime resolves
// from cwd - so the drawer must run with cwd inside this repo, and
// settingSources "user" makes it load the user-level MCP config at all.
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

// Trimmed from Figma's mandatory `figma-use` skill (github.com/figma/mcp-server-guide),
// keeping only the rules that apply to FigJam boards. use_figma executes Plugin
// API JavaScript in the file context; these are the failure modes that matter.
const FIGJAM_GUIDE = `Rules for use_figma on a FigJam board (the URL is figma.com/board/..., NOT a Design file):
- Only FigJam node types work: figma.createSticky(), figma.createShapeWithText(), figma.createConnector(), figma.createSection(), figma.createText(). Design-mode nodes (Frame, Rectangle, auto layout) are blocked, and figma.createPage() does not exist in FigJam - never call it.
- Every text mutation must load the font first: await figma.loadFontAsync({ family: "Inter", style: "Medium" }) before setting .characters (stickies and shapes use Inter Medium by default). Skipping the load throws "Cannot write to node with unloaded font".
- await EVERY Promise (loadFontAsync, setCurrentPageAsync, ...). Fire-and-forget async calls half-apply changes.
- At most ~10 logical operations (create node + set properties + parent it) per use_figma call. Split bigger updates across several calls.
- Each call's response must stay small (20kb hard limit): return only node ids and short labels, never full node dumps.
- Inspect before writing: first run a read-only script that finds existing content and returns ids/types/text, then mutate.
- Map paper content to FigJam idioms: headings and free-standing labels -> Text nodes; list items and note blocks -> Stickies; boxes, tables and enclosed regions -> ShapeWithText; arrows and connecting lines -> Connectors wired to the two node ids they join (connectorStart/connectorEnd with endpointNodeId).
- Preserve the paper's relative spatial layout: place nodes so their positions match the snapshot's arrangement (scale roughly 1500x1150 canvas units per page).`;

export type FigmaSyncState = "idle" | "syncing" | "error";

/**
 * Mirrors the paper board onto a FigJam board through Figma's official remote
 * MCP server. One sync runs at a time with a newest-wins policy: a fresh board
 * state cancels an in-flight sync, because drawing an outdated board wastes
 * minutes and the next sync redraws everything anyway.
 */
export class FigmaSync {
  private chain: Promise<unknown> = Promise.resolve();
  private latestRequest = 0;
  private cancelCurrent: (() => void) | null = null;
  private passCounter = 0;
  private modelId: string | null = null;
  public state: FigmaSyncState = "idle";
  public lastError: string | null = null;

  constructor(
    private apiKey: string,
    private boardUrl: string,
  ) {}

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
      // The drawer needs vision (it transcribes the snapshot itself) but the
      // mirror is only useful if it lands quickly: opus-4-8 reads handwriting
      // best but thinks for minutes between tool calls; sonnet reads well
      // enough and moves much faster.
      const preferred =
        ids.find((id) => /sonnet/i.test(id)) ??
        ids.find((id) => /opus-4-8/i.test(id)) ??
        ids.find((id) => /fable/i.test(id)) ??
        ids.find((id) => /gpt/i.test(id));
      this.modelId = preferred ?? "auto";
    } catch {
      this.modelId = "auto";
    }
    return this.modelId;
  }

  /** Fire-and-forget: errors land in `state`/`lastError`, never on the caller. */
  sync(pngBase64: string): void {
    const requestId = ++this.latestRequest;
    this.cancelCurrent?.();
    const task = async () => {
      if (requestId !== this.latestRequest) return;
      await this.runOnce(pngBase64);
    };
    this.chain = this.chain.then(task, task).then(
      () => {
        if (requestId === this.latestRequest) {
          this.state = "idle";
          this.lastError = null;
        }
      },
      (err) => {
        if (requestId === this.latestRequest) {
          this.state = "error";
          this.lastError = err instanceof Error ? err.message : String(err);
        }
        console.error("[figma] sync failed:", err instanceof Error ? err.message : err);
      },
    );
  }

  private async runOnce(pngBase64: string): Promise<void> {
    const started = Date.now();
    const passId = ++this.passCounter;
    this.state = "syncing";
    const t = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);

    const prompt = `You mirror a hand-drawn paper whiteboard onto a FigJam board using the "figma" MCP server tools.

Target FigJam board: ${this.boardUrl}

${FIGJAM_GUIDE}

Workflow for this update:
1. Transcribe the attached snapshot of the paper: read letter by letter and do not substitute words that merely fit the context. Ignore hands, pens and anything that is not ink on the page.
2. Inspect the board with one read-only use_figma script: find the section named "Paper board" and return its children (ids, types, text). If the section does not exist yet, create it in step 3.
3. Make that section match the paper: update text on nodes that changed, create what is missing, remove section children that are no longer on the paper. Never touch anything outside the "Paper board" section.
4. When the section matches, reply with exactly DONE - no summary. If the figma MCP tools are unavailable or fail with an authentication or connection error, reply with FAIL: followed by the exact error text.

This is a live mirror and speed matters: plan once, keep thinking brief, batch each use_figma call up to the ~10-operation limit, and do not re-read the board between writes or run a final verification pass.`;

    let agent: SDKAgent | null = null;
    try {
      const model = await this.pickModel();
      agent = await Agent.create({
        apiKey: this.apiKey,
        model: { id: model },
        name: "FigJam sync",
        local: { cwd: REPO_ROOT, settingSources: ["user"] },
      });

      const run = await agent.send({
        text: prompt,
        images: [{ data: pngBase64, mimeType: "image/png" }],
      });
      this.cancelCurrent = () => {
        console.log(`[figma ${passId}] cancelled: superseded by a newer board state`);
        run.cancel().catch(() => {});
      };
      const timeout = setTimeout(() => run.cancel().catch(() => {}), RUN_TIMEOUT_MS);

      let text = "";
      console.log(`[figma ${passId}] ${t()}s sync started at ${new Date().toLocaleTimeString()} (${model})`);
      try {
        for await (const event of run.stream()) {
          if (event.type === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "text") text += block.text;
            }
          } else if (event.type === "tool_call") {
            console.log(`[figma ${passId}] ${t()}s tool ${event.name} ${event.status}`);
          }
        }
        const result = await run.wait();
        if (result.status !== "finished") {
          throw new Error(`figma agent run ${result.status}: ${result.error?.message ?? "no details"}`);
        }
        if (!text && result.result) text = result.result;
      } finally {
        this.cancelCurrent = null;
        clearTimeout(timeout);
      }

      if (/^\s*FAIL\b/m.test(text) || !/\bDONE\b/.test(text)) {
        throw new Error(text.trim().slice(0, 300) || "figma agent finished without confirming DONE");
      }
      console.log(`[figma ${passId}] ${t()}s board synced`);
    } finally {
      if (agent) void agent[Symbol.asyncDispose]().catch(() => {});
    }
  }
}
