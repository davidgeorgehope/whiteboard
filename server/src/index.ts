import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { FigmaSync } from "./figma-sync.js";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const PORT = Number(process.env.PORT ?? 8787);
const apiKey = process.env.CURSOR_API_KEY ?? "";
const figmaBoardUrl = process.env.FIGMA_BOARD_URL ?? "";

// Figma auth is not an env var: the drawer agent inherits the OAuth session
// created by `cursor-agent mcp login figma` (see figma-sync.ts).
const figmaSync = apiKey && figmaBoardUrl ? new FigmaSync(apiKey, figmaBoardUrl) : null;

const app = express();
app.use(express.json({ limit: "30mb" }));

app.get("/api/status", async (_req, res) => {
  if (!figmaSync) {
    const missing = !apiKey ? "CURSOR_API_KEY" : "FIGMA_BOARD_URL";
    res.json({ hasKey: false, model: null, figma: null, lastError: `${missing} is not set (see .env.example)` });
    return;
  }
  const model = figmaSync.model ?? (await figmaSync.pickModel().catch(() => null));
  res.json({
    hasKey: true,
    model,
    lastError: null,
    figma: { state: figmaSync.state, lastError: figmaSync.lastError },
  });
});

// Fire-and-forget: the sync runs for minutes, so the request returns
// immediately and the client tracks progress through /api/status.
app.post("/api/sync", (req, res) => {
  if (!figmaSync) {
    res.status(503).json({ error: "Set CURSOR_API_KEY and FIGMA_BOARD_URL in .env (see .env.example)." });
    return;
  }
  const image: unknown = req.body?.image;
  if (typeof image !== "string") {
    res.status(400).json({ error: "expected { image: dataUrl }" });
    return;
  }
  const blobs = Array.isArray(req.body?.blobs) ? req.body.blobs : [];
  const base64 = image.replace(/^data:image\/\w+;base64,/, "");
  console.log(`[sync] ${new Date().toLocaleTimeString()} snapshot received`);
  figmaSync.sync(base64, blobs);
  res.status(202).json({ state: figmaSync.state });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  if (!figmaSync) {
    console.warn("[server] set CURSOR_API_KEY and FIGMA_BOARD_URL in .env to enable FigJam sync");
  }
});
