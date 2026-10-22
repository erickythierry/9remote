// Custom terminal backgrounds: the client sends an image data URL, the agent
// decodes, scales + compresses, stores one file per background under ~/.9remote
// and serves the list back so every device logged in shares the same wallpapers.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("background");

// Tunables: input cap guards the decode step; quality steps walk the stored
// size under the cap. maxDim = longest edge (phone wallpaper, rendered via cover).
// custom.jpg is the legacy single-file id "custom"; new saves get bg<timestamp36>.
const BACKGROUND = {
  maxInputBytes: 10 * 1024 * 1024,
  maxStoredBytes: 400 * 1024,
  maxDim: 1080,
  qualities: [78, 65, 50],
  maxCount: 8
};
type BackgroundPayload = { dataUrl?: string; id?: string };
type Ack = (result: Record<string, unknown>) => void;
type BackgroundSocket = { on: (event: string, listener: (payload?: BackgroundPayload, cb?: Ack) => void) => unknown };

// data:image/...;base64 payload → Buffer (null when malformed / over cap)
function decodeDataUrl(dataUrl: unknown): Buffer | null {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  return buf.length && buf.length <= BACKGROUND.maxInputBytes ? buf : null;
}

// EXIF-rotate, scale longest edge down to maxDim, then walk JPEG quality until
// the buffer fits the stored cap (never enlarges a smaller image).
async function compressImage(input: Buffer): Promise<Buffer> {
  let out: Buffer | null = null;
  for (const quality of BACKGROUND.qualities) {
    out = await sharp(input)
      .rotate()
      .resize({ width: BACKGROUND.maxDim, height: BACKGROUND.maxDim, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= BACKGROUND.maxStoredBytes) return out;
  }
  return out!;
}

// Ids come from the client — restrict to [a-z0-9] so path.join can't traverse.
const isValidId = (id: unknown): id is string => /^[a-z0-9]+$/i.test(String(id || ""));
const fileFor = (id: string): string => path.join(PATHS.BACKGROUNDS, `${id}.jpg`);

// Stored backgrounds, oldest first (mtime) — stable tile order in the picker.
function listBackgrounds(): Array<{ id: string; mtime: number }> {
  try {
    return fs.readdirSync(PATHS.BACKGROUNDS)
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => {
        const file = path.join(PATHS.BACKGROUNDS, f);
        return { id: f.slice(0, -4), mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
  } catch {
    return [];
  }
}

function readBackground(id: string): Buffer | null {
  try {
    const buf = fs.readFileSync(fileFor(id));
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

export function setupBackgroundHandlers(socket: unknown): void {
  const eventSocket = socket as BackgroundSocket;
  eventSocket.on("bg:save", async (payload = {}, cb) => {
    try {
      if (listBackgrounds().length >= BACKGROUND.maxCount) {
        return cb?.({ success: false, error: `Background limit reached (${BACKGROUND.maxCount})` });
      }
      const input = decodeDataUrl(payload.dataUrl);
      if (!input) return cb?.({ success: false, error: "Invalid image source" });

      const id = `bg${Date.now().toString(36)}`;
      const out = await compressImage(input);
      fs.mkdirSync(PATHS.BACKGROUNDS, { recursive: true });
      fs.writeFileSync(fileFor(id), out);
      logger.info(`background ${id} saved (${(out.length / 1024).toFixed(0)}KB)`);
      cb?.({ success: true, id, dataUrl: `data:image/jpeg;base64,${out.toString("base64")}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`bg:save failed: ${message}`);
      cb?.({ success: false, error: message });
    }
  });

  eventSocket.on("bg:list", (_payload, cb) => {
    const items = listBackgrounds()
      .map(({ id }) => {
        const buf = readBackground(id);
        return buf ? { id, dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` } : null;
      })
      .filter(Boolean);
    cb?.({ success: true, items });
  });

  eventSocket.on("bg:get", (payload = {}, cb) => {
    const id = isValidId(payload.id) ? payload.id : "custom";
    const buf = readBackground(id);
    if (!buf) return cb?.({ success: false });
    cb?.({ success: true, dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` });
  });

  eventSocket.on("bg:delete", (payload = {}, cb) => {
    if (!isValidId(payload.id)) return cb?.({ success: false, error: "Invalid id" });
    try {
      fs.unlinkSync(fileFor(payload.id));
      logger.info(`background ${payload.id} deleted`);
      cb?.({ success: true });
    } catch (error) {
      cb?.({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
