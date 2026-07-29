import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { Beautifier } from "./beautifier.js";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const PORT = Number(process.env.PORT ?? 8787);
const apiKey = process.env.CURSOR_API_KEY ?? "";

const beautifier = apiKey ? new Beautifier(apiKey) : null;

const app = express();
app.use(express.json({ limit: "30mb" }));

app.get("/api/status", async (_req, res) => {
  if (!beautifier) {
    res.json({ hasKey: false, model: null, lastError: "CURSOR_API_KEY is not set (see .env.example)" });
    return;
  }
  const model = beautifier.model ?? (await beautifier.pickModel().catch(() => null));
  res.json({ hasKey: true, model, lastError: beautifier.lastError });
});

// Fresh board session: dispose the agent so old page content can't leak
// into the next page's render via conversation history.
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
  let gone = false;
  res.on("close", () => {
    if (!res.writableEnded) gone = true;
  });
  try {
    const result = await beautifier.beautify(base64, () => gone);
    res.json({
      image: `data:image/png;base64,${result.png}`,
      durationMs: result.durationMs,
      model: beautifier.model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[beautify] failed:", message);
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
