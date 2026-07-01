import type { ProofAnnotation } from "../types";

/**
 * Burn drawing instructions into an image on an offscreen canvas and return
 * the result as a PNG data URL. Runs in the webview because it's the only
 * layer with full 2D drawing + system typography — no native image libraries
 * in the extension host, nothing new to package in the .vsix.
 */

const DEFAULT_COLOR = "#FF3B30";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the source image"));
    img.src = src;
  });
}

interface Metrics {
  w: number;
  h: number;
  /** Stroke width / font size scale with image size so annotations stay
   * legible on retina (2x) captures without dwarfing small crops. */
  line: number;
  font: number;
}

/** Resolve one coordinate according to the annotation's unit. `axis` picks the
 * dimension percent values are relative to. */
function coord(
  value: number | undefined,
  a: ProofAnnotation,
  m: Metrics,
  axis: "x" | "y"
): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  if (a.unit === "percent") {
    return (value / 100) * (axis === "x" ? m.w : m.h);
  }
  return value;
}

/** Stroke a path twice — dark halo then color — so annotations stay visible on
 * both light and dark screenshots. */
function contrastStroke(ctx: CanvasRenderingContext2D, color: string, line: number, draw: () => void): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = line + Math.max(2, line * 0.5);
  draw();
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = line;
  draw();
  ctx.stroke();
  ctx.restore();
}

/** A rounded label pill with white text, clamped inside the canvas. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  m: Metrics
): void {
  const padX = m.font * 0.5;
  const padY = m.font * 0.3;
  ctx.save();
  ctx.font = `600 ${m.font}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  const bh = m.font + padY * 2;
  const bx = Math.max(2, Math.min(x, m.w - bw - 2));
  const by = Math.max(2, Math.min(y, m.h - bh - 2));
  const r = Math.min(bh / 2, m.font * 0.4);

  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
  ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
  ctx.arcTo(bx, by + bh, bx, by, r);
  ctx.arcTo(bx, by, bx + bw, by, r);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.92;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, bx + padX, by + bh / 2 + 0.5);
  ctx.restore();
}

function drawRectLike(ctx: CanvasRenderingContext2D, a: ProofAnnotation, m: Metrics, color: string): void {
  const x = coord(a.x, a, m, "x") ?? 0;
  const y = coord(a.y, a, m, "y") ?? 0;
  const w = coord(a.width, a, m, "x") ?? m.w * 0.2;
  const h = coord(a.height, a, m, "y") ?? m.h * 0.2;

  if (a.kind === "highlight") {
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    contrastStroke(ctx, color, Math.max(1.5, m.line * 0.6), () => {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
    });
  } else if (a.kind === "ellipse") {
    contrastStroke(ctx, color, m.line, () => {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    });
  } else {
    contrastStroke(ctx, color, m.line, () => {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
    });
  }
  if (a.text) {
    drawLabel(ctx, a.text, x, y - m.font * 2, color, m);
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, a: ProofAnnotation, m: Metrics, color: string): void {
  const x1 = coord(a.x1, a, m, "x") ?? m.w * 0.25;
  const y1 = coord(a.y1, a, m, "y") ?? m.h * 0.25;
  const x2 = coord(a.x2, a, m, "x") ?? m.w * 0.5;
  const y2 = coord(a.y2, a, m, "y") ?? m.h * 0.5;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(12, m.line * 4);
  // Stop the shaft short of the tip so it doesn't poke through the head.
  const sx = x2 - Math.cos(angle) * head * 0.6;
  const sy = y2 - Math.sin(angle) * head * 0.6;

  contrastStroke(ctx, color, m.line, () => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(sx, sy);
  });

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - head * Math.cos(angle - Math.PI / 6),
    y2 - head * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    x2 - head * Math.cos(angle + Math.PI / 6),
    y2 - head * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (a.text) {
    drawLabel(ctx, a.text, x1 + m.font * 0.5, y1 - m.font * 2, color, m);
  }
}

function drawBadge(ctx: CanvasRenderingContext2D, a: ProofAnnotation, m: Metrics, color: string): void {
  const x = coord(a.x, a, m, "x") ?? m.w / 2;
  const y = coord(a.y, a, m, "y") ?? m.h / 2;
  const text = a.text || "•";
  const r = Math.max(12, m.font * 0.95);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(2, m.line * 0.5);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();
  ctx.font = `700 ${r * 1.1}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, y + r * 0.05);
  ctx.restore();
}

export async function renderAnnotatedImage(
  src: string,
  annotations: ProofAnnotation[]
): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.drawImage(img, 0, 0);

  const minDim = Math.min(canvas.width, canvas.height);
  const m: Metrics = {
    w: canvas.width,
    h: canvas.height,
    line: Math.max(3, Math.round(minDim * 0.005)),
    font: Math.max(14, Math.round(minDim * 0.022)),
  };

  for (const a of annotations || []) {
    const color = a.color || DEFAULT_COLOR;
    switch (a.kind) {
      case "rect":
      case "ellipse":
      case "highlight":
        drawRectLike(ctx, a, m, color);
        break;
      case "arrow":
        drawArrow(ctx, a, m, color);
        break;
      case "badge":
        drawBadge(ctx, a, m, color);
        break;
      case "text": {
        const x = coord(a.x, a, m, "x") ?? m.w * 0.05;
        const y = coord(a.y, a, m, "y") ?? m.h * 0.05;
        drawLabel(ctx, a.text || "", x, y, color, m);
        break;
      }
      default:
        // Unknown kind: skip rather than fail the whole render.
        break;
    }
  }

  return canvas.toDataURL("image/png");
}
