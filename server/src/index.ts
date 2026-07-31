import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { Beautifier } from "./beautifier.js";
import { FigmaSync } from "./figma-sync.js";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const PORT = Number(process.env.PORT ?? 8787);
const apiKey = process.env.CURSOR_API_KEY ?? "";
const figmaBoardUrl = process.env.FIGMA_BOARD_URL ?? "";

const beautifier = apiKey ? new Beautifier(apiKey) : null;
// Figma auth is not an env var: the drawer agent inherits the OAuth session
// created by `cursor-agent mcp login figma` (see figma-sync.ts).
const figmaSync =
  beautifier && figmaBoardUrl
    ? new FigmaSync(apiKey, figmaBoardUrl, () => beautifier.pickModel())
    : null;

const app = express();
app.use(express.json({ limit: "30mb" }));

app.get("/api/status", async (_req, res) => {
  if (!beautifier) {
    res.json({ hasKey: false, model: null, lastError: "CURSOR_API_KEY is not set (see .env.example)" });
    return;
  }
  const model = beautifier.model ?? (await beautifier.pickModel().catch(() => null));
  res.json({
    hasKey: true,
    model,
    lastError: beautifier.lastError,
    figma: figmaSync ? { state: figmaSync.state, lastError: figmaSync.lastError } : null,
  });
});

// Fresh board session: drop the cached render so a new page's SKIP fallback
// can't serve the previous page's board.
app.post("/api/reset", async (_req, res) => {
  await beautifier?.reset();
  res.json({ ok: true });
});

app.post("/api/beautify", async (req, res) => {
  if (!beautifier) {
    res.status(503).json({ error: "CURSOR_API_KEY is not set. Copy .env.example to .env and add your key." });
    return;
  }
  const image: unknown = req.body?.image;
  if (typeof image !== "string") {
    res.status(400).json({ error: "expected { image: dataUrl }" });
    return;
  }
  const base64 = image.replace(/^data:image\/\w+;base64,/, "");
  const stamp = () => new Date().toLocaleTimeString();
  console.log(`[beautify] ${stamp()} request received`);
  let gone = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      gone = true;
      console.log(`[beautify] ${stamp()} client disconnected before delivery`);
    }
  });
  try {
    const result = await beautifier.beautify(base64, () => gone);
    // Mirror to FigJam in the background; SKIP passes carry no new content.
    if (figmaSync && req.body?.figma !== false && !result.skipped) {
      figmaSync.sync(result.spec, base64);
    }
    res.json({
      image: `data:image/png;base64,${result.png}`,
      durationMs: result.durationMs,
      model: beautifier.model,
    });
    console.log(`[beautify] ${stamp()} delivered (${(result.durationMs / 1000).toFixed(1)}s)${gone ? " to disconnected client" : ""}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[beautify] ${stamp()} failed:`, message);
    res.status(500).json({ error: message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  if (!apiKey) {
    console.warn("[server] CURSOR_API_KEY is not set - beautification disabled until you add it to .env");
  }
});

async function shutdown() {
  server.close();
  await beautifier?.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
