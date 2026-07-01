import { Camera } from "lucide-react";
import ZoomableImage from "./ZoomableImage";

/**
 * A screenshot Claude explicitly presented as visual proof (via the luxure
 * MCP tools). Unlike tool-result thumbnails this is the point of the turn, so
 * it renders as a prominent card: image first, caption underneath.
 */
export default function ProofCard({
  images,
  caption,
}: {
  images: string[];
  caption?: string;
}) {
  if (!images || images.length === 0) {
    return null;
  }
  return (
    <div className="my-1.5 rounded-md border border-[rgba(245,158,11,0.35)] bg-[var(--app-surface)] overflow-hidden">
      <div className="p-2 flex flex-col gap-2">
        {images.map((src, i) => (
          <ZoomableImage
            key={i}
            src={src}
            alt={caption || `Screenshot ${i + 1}`}
            className="w-full max-h-96 object-contain rounded cursor-zoom-in bg-[rgba(0,0,0,0.25)]"
          />
        ))}
      </div>
      <div className="flex items-center gap-1.5 px-2.5 pb-2 text-[11px] text-vscode-descriptionFg">
        <Camera size={12} className="shrink-0 text-[#f59e0b]" />
        <span className="truncate">{caption || "Screenshot from Claude"}</span>
      </div>
    </div>
  );
}
