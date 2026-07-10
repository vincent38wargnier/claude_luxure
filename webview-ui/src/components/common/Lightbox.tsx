import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize,
  Minus,
  Plus,
  X,
} from "lucide-react";
import vscode from "../../vscode";

const MIN_SCALE = 1;
const MAX_SCALE = 8;

/** Clamp a translation so the zoomed image can't be pushed fully off-stage. */
function clampT(t: number, imgDim: number, stageDim: number, scale: number): number {
  const max = Math.max(0, (imgDim * scale - stageDim) / 2);
  return Math.min(max, Math.max(-max, t));
}

const btnCls =
  "p-1 rounded text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/80";

/**
 * Full-panel image viewer: wheel / buttons / double-click zoom with
 * drag-to-pan, ←/→ paging through the opened set, Esc to close, and an
 * "open in editor tab" escape hatch (native VS Code image preview, full
 * window). Rendered through a portal so transformed card ancestors can't
 * shrink or clip it.
 */
export default function Lightbox({
  images,
  initialIndex,
  altPrefix = "Image",
  onClose,
}: {
  images: string[];
  initialIndex: number;
  altPrefix?: string;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(() =>
    Math.min(images.length - 1, Math.max(0, initialIndex))
  );
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  // Mirror for native/pointer handlers that must read the latest transform.
  const viewRef = useRef(view);
  viewRef.current = view;

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const resetView = useCallback(() => {
    setView({ scale: 1, tx: 0, ty: 0 });
  }, []);

  const go = useCallback(
    (delta: number) => {
      setIdx((cur) => Math.min(images.length - 1, Math.max(0, cur + delta)));
      setView({ scale: 1, tx: 0, ty: 0 });
    },
    [images.length]
  );

  /** Zoom to `nextScale`, keeping the point under (clientX, clientY) fixed. */
  const applyZoom = useCallback((clientX: number, clientY: number, nextScale: number) => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img) {
      return;
    }
    const v = viewRef.current;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    if (scale === 1) {
      setView({ scale: 1, tx: 0, ty: 0 });
      return;
    }
    const rect = stage.getBoundingClientRect();
    const irect = img.getBoundingClientRect();
    const baseW = irect.width / v.scale;
    const baseH = irect.height / v.scale;
    // Cursor relative to the stage center (the transform origin).
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);
    const k = scale / v.scale;
    setView({
      scale,
      tx: clampT(px - k * (px - v.tx), baseW, rect.width, scale),
      ty: clampT(py - k * (py - v.ty), baseH, rect.height, scale),
    });
  }, []);

  const zoomCenter = useCallback(
    (factor: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      applyZoom(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        viewRef.current.scale * factor
      );
    },
    [applyZoom]
  );

  // Native listener: wheel must be non-passive to stop the transcript behind
  // the overlay from scrolling while zooming.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyZoom(
        e.clientX,
        e.clientY,
        viewRef.current.scale * Math.exp(-e.deltaY * 0.0022)
      );
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (viewRef.current.scale <= 1) {
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = viewRef.current;
    dragRef.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!drag || !stage || !img) {
      return;
    }
    const v = viewRef.current;
    const srect = stage.getBoundingClientRect();
    const irect = img.getBoundingClientRect();
    const baseW = irect.width / v.scale;
    const baseH = irect.height / v.scale;
    setView({
      scale: v.scale,
      tx: clampT(drag.tx + (e.clientX - drag.x), baseW, srect.width, v.scale),
      ty: clampT(drag.ty + (e.clientY - drag.y), baseH, srect.height, v.scale),
    });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowRight") {
      e.stopPropagation();
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.stopPropagation();
      e.preventDefault();
      go(-1);
    } else if (e.key === "+" || e.key === "=") {
      e.stopPropagation();
      zoomCenter(1.4);
    } else if (e.key === "-") {
      e.stopPropagation();
      zoomCenter(1 / 1.4);
    } else if (e.key === "0") {
      e.stopPropagation();
      resetView();
    }
  };

  const openInEditor = () => {
    vscode.postMessage({
      type: "openImageInEditor",
      dataUrl: images[idx],
      label: `${altPrefix}-${idx + 1}`,
    });
  };

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer — ${idx + 1} of ${images.length}`}
      tabIndex={-1}
      className="fixed inset-0 z-[100] bg-black/90 outline-none select-none"
      onKeyDown={onKeyDown}
    >
      {/* Stage: clicking the dark area closes; the image itself is inert. */}
      <div
        ref={stageRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden cursor-zoom-out"
        onClick={onClose}
      >
        <img
          ref={imgRef}
          src={images[idx]}
          alt={`${altPrefix} ${idx + 1} of ${images.length}`}
          draggable={false}
          className="max-w-full max-h-full object-contain shadow-2xl"
          style={{
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            cursor: view.scale > 1 ? "grab" : "default",
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (viewRef.current.scale > 1) {
              resetView();
            } else {
              applyZoom(e.clientX, e.clientY, 2.5);
            }
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      {/* Toolbar */}
      <div
        className="absolute top-2 right-2 flex items-center gap-0.5 rounded-md bg-black/60 px-1.5 py-1"
        onClick={(e) => e.stopPropagation()}
      >
        {images.length > 1 && (
          <span className="px-1.5 text-xs text-white/80 tabular-nums">
            {idx + 1} / {images.length}
          </span>
        )}
        <button className={btnCls} aria-label="Zoom out (-)" title="Zoom out (−)" onClick={() => zoomCenter(1 / 1.4)}>
          <Minus size={14} />
        </button>
        <span className="w-9 text-center text-xs text-white/80 tabular-nums">
          {view.scale === 1 ? "Fit" : `${Math.round(view.scale * 100)}%`}
        </span>
        <button className={btnCls} aria-label="Zoom in (+)" title="Zoom in (+)" onClick={() => zoomCenter(1.4)}>
          <Plus size={14} />
        </button>
        <button className={btnCls} aria-label="Reset zoom (0)" title="Fit to panel (0)" onClick={resetView}>
          <Maximize size={14} />
        </button>
        <button
          className={btnCls}
          aria-label="Open in editor tab"
          title="Open big in a VS Code editor tab"
          onClick={openInEditor}
        >
          <ExternalLink size={14} />
        </button>
        <button className={btnCls} aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {/* Set navigation */}
      {images.length > 1 && (
        <>
          <button
            className={`absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 ${btnCls}`}
            aria-label="Previous image (←)"
            disabled={idx === 0}
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 ${btnCls}`}
            aria-label="Next image (→)"
            disabled={idx === images.length - 1}
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </div>,
    document.body
  );
}
