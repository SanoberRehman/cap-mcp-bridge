/**
 * Renders docs/demo.gif from a *real* bridge session: it starts the CLI over stdio against a
 * running bookshop (examples/bookshop, `cds watch`), makes the tool calls from DEMO.md, and draws
 * the actual arguments and responses into terminal-style frames.
 *
 *   cd scripts/demo-gif && npm install && cd ../..
 *   npm run demo:gif -- http://localhost:4004/odata/v4/catalog
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
// Loaded with require so the main package never depends on the native canvas binding.
const { createCanvas } = require("@napi-rs/canvas") as {
  createCanvas: (w: number, h: number) => {
    getContext: (kind: "2d") => {
      fillStyle: string;
      font: string;
      fillRect: (x: number, y: number, w: number, h: number) => void;
      fillText: (text: string, x: number, y: number) => void;
      beginPath: () => void;
      arc: (x: number, y: number, r: number, a: number, b: number) => void;
      fill: () => void;
      getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
    };
    toBuffer: (mime: "image/png") => Buffer;
  };
};
/** Set DEMO_GIF_SNAPSHOT_DIR to also dump a few frames as PNG for a quick visual check. */
const SNAPSHOT_DIR = process.env["DEMO_GIF_SNAPSHOT_DIR"];
const { GIFEncoder, quantize, applyPalette } = require("gifenc") as {
  GIFEncoder: () => { writeFrame: (index: Uint8Array, w: number, h: number, opts: { palette: number[][]; delay: number }) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (rgba: Uint8ClampedArray | Uint8Array, maxColors: number) => number[][];
  applyPalette: (rgba: Uint8ClampedArray | Uint8Array, palette: number[][]) => Uint8Array;
};

const url = process.argv[2] ?? "http://localhost:4004/odata/v4/catalog";
const OUT = "docs/demo.gif";
const W = 880;
const H = 500;
const PAD = 22;
const LINE = 20;
const FONT = '15px Consolas, "Cascadia Mono", "DejaVu Sans Mono", Menlo, monospace';
const COLORS = { bg: "#0f1117", text: "#d6dbe5", dim: "#7b8496", prompt: "#7ee787", tool: "#79c0ff", err: "#ff7b72", accent: "#d2a8ff", bar: "#1a1f2b" };

type Line = { text: string; color?: string };
const frames: Array<{ lines: Line[]; delay: number }> = [];
const screen: Line[] = [];

function push(delay: number): void {
  frames.push({ lines: screen.slice(-((H - 2 * PAD - 30) / LINE | 0)), delay });
}
function say(text: string, color?: string, delay = 60): void {
  screen.push(color ? { text, color } : { text });
  push(delay);
}
function typeLine(prefix: string, text: string, color: string): void {
  for (let i = 3; i <= text.length; i += 3) {
    screen.push({ text: `${prefix}${text.slice(0, i)}▌`, color });
    push(45);
    screen.pop();
  }
  screen.push({ text: `${prefix}${text}`, color });
  push(500);
}
function hold(ms: number): void {
  push(ms);
}
function blank(): void {
  screen.push({ text: "" });
}

/* ---------------- real session ---------------- */

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/cli.ts", "--url", url, "--log-level", "silent"],
  stderr: "ignore",
});
const client = new Client({ name: "demo-gif", version: "0" });

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: Record<string, unknown> }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
  return { isError: Boolean(res.isError), json: JSON.parse(text) as Record<string, unknown> };
}

function showCall(name: string, args: Record<string, unknown>): void {
  say(`  -> ${name} ${JSON.stringify(args)}`, COLORS.tool, 700);
}

await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);

typeLine("$ ", `npx cap-mcp-bridge --url ${url}`, COLORS.prompt);
say(`  read $metadata → ${tools.length} tools generated, ${tools.filter((t) => t.startsWith("query_")).length} entity sets`, COLORS.dim, 400);
say(`  ${tools.slice(0, 9).join("  ")} …`, COLORS.dim, 1200);
blank();

// 1. list
typeLine("> ", "What data is in this service?", COLORS.accent);
showCall("list_entity_sets", { includeCounts: true });
const list = await call("list_entity_sets", { includeCounts: true });
for (const s of (list.json["entitySets"] as Array<Record<string, unknown>>).slice(0, 7)) {
  const caps = s["capabilities"] as Record<string, boolean>;
  const flags = [s["draftEnabled"] ? "draft" : "", !caps["insertable"] && !caps["updatable"] ? "read-only" : ""].filter(Boolean).join(", ");
  const descr = s["description"] ? String(s["description"]) : "";
  const short = descr.length > 44 ? `${descr.slice(0, 43).replace(/\s+\S*$/, "")}…` : descr;
  say(`  ${String(s["name"]).padEnd(12)} ${String(s["recordCount"]).padStart(3)} records${short ? `  - ${short}` : ""}${flags ? `  (${flags})` : ""}`, COLORS.text, 120);
}
hold(1500);
blank();

// 2. filter + orderBy
typeLine("> ", "Which books cost more than 12, most expensive first?", COLORS.accent);
const q1 = { filter: { field: "price", op: "gt", value: "12" }, orderBy: [{ field: "price", dir: "desc" }], select: ["title", "price"] };
showCall("query_Books", q1);
const r1 = await call("query_Books", q1);
say(`  $filter=price gt 12  $orderby=price desc  $count=true  →  ${r1.json["count"]} of ${r1.json["count"]}`, COLORS.dim, 300);
for (const row of r1.json["results"] as Array<Record<string, unknown>>) say(`  ${String(row["title"]).padEnd(24)} ${row["price"]}`, COLORS.text, 120);
hold(1400);
blank();

// 3. expand across association + redaction
typeLine("> ", "Who wrote them, and where was each author born?", COLORS.accent);
const q2 = { ...q1, expand: ["author"] };
showCall("query_Books", q2);
const r2 = await call("query_Books", q2);
say("  one call, $expand=author, joined across the association:", COLORS.dim, 300);
for (const row of r2.json["results"] as Array<Record<string, Record<string, unknown>>>) {
  const a = row["author"] ?? {};
  say(`  ${String(row["title"]).padEnd(20)} ${String(a["name"]).padEnd(18)} ${String(a["placeOfBirth"]).padEnd(24)} email: ${a["email"]}`, COLORS.text, 120);
}
say("  email is @PersonalData.IsPotentiallySensitive in the CDS model → redacted automatically", COLORS.dim, 1600);
blank();

// 4. self-correction
typeLine("> ", 'Find books whose name contains "Raven"', COLORS.accent);
const bad = { filter: { field: "name", op: "contains", value: "Raven" } };
showCall("query_Books", bad);
const rBad = await call("query_Books", bad);
const err = rBad.json["error"] as Record<string, unknown>;
say(`  x  ${err["code"]}: ${err["message"]}`, COLORS.err, 200);
say(`    validOptions: ${(err["validOptions"] as string[]).join(", ")}`, COLORS.err, 200);
say("    (no request was sent; the model can fix this itself)", COLORS.dim, 1200);
const good = { filter: { field: "title", op: "contains", value: "Raven" }, select: ["title", "stock"] };
showCall("query_Books", good);
const rGood = await call("query_Books", good);
for (const row of rGood.json["results"] as Array<Record<string, unknown>>) say(`  +  ${row["title"]}  (stock ${row["stock"]})`, COLORS.prompt, 1300);
blank();

// 5. drafts
typeLine("> ", "How many orders are there?", COLORS.accent);
showCall("query_Orders", { select: ["orderNo", "customer"] });
const r3 = await call("query_Orders", { select: ["orderNo", "customer"] });
say(`  count: ${r3.json["count"]}   $filter=IsActiveEntity eq true (injected: draft-enabled entity)`, COLORS.text, 200);
say(`  ${(r3.json["notes"] as string[])[0]}`, COLORS.dim, 1500);
blank();
say("  read-only by default · paged + counted · ~50KB ceiling · redaction · zero per-service code", COLORS.accent, 2500);

await client.close();

/* ---------------- draw ---------------- */

const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
const gif = GIFEncoder();

for (const [n, frame] of frames.entries()) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = COLORS.bar;
  ctx.fillRect(0, 0, W, 30);
  for (const [i, c] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(18 + i * 20, 15, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = COLORS.dim;
  ctx.font = FONT;
  ctx.fillText("cap-mcp-bridge — real session against examples/bookshop", 90, 20);
  let y = 30 + PAD + 4;
  for (const line of frame.lines) {
    ctx.fillStyle = line.color ?? COLORS.text;
    ctx.fillText(line.text.length > 112 ? `${line.text.slice(0, 111)}…` : line.text, PAD, y);
    y += LINE;
  }
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const palette = quantize(rgba, 256);
  const index = applyPalette(rgba, palette);
  gif.writeFrame(index, W, H, { palette, delay: frame.delay });
  if (SNAPSHOT_DIR && (n % 30 === 0 || n === frames.length - 1)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(`${SNAPSHOT_DIR}/frame-${String(n).padStart(3, "0")}.png`, canvas.toBuffer("image/png"));
  }
}
gif.finish();
mkdirSync("docs", { recursive: true });
writeFileSync(OUT, gif.bytes());
console.log(`wrote ${OUT}: ${frames.length} frames, ${(gif.bytes().length / 1024).toFixed(0)} KB`);
