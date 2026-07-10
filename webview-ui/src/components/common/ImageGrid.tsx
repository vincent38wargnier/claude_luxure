import { useState } from "react";
import Lightbox from "./Lightbox";

/**
 * Images inside a chat message. A single image keeps its natural aspect ratio
 * (height-capped, like before); two or more become uniform tiles in a grid
 * whose column count follows the chat panel's real width via container
 * queries (see .img-grid in index.css): 1 column in a narrow sidebar,
 * 2 from 440px, 3 from 760px.
 *
 * Clicking any image opens the full-panel Lightbox, which pages (←/→)
 * through every image currently visible in this pane's conversation — so
 * consecutive one-image cards (e.g. a run of proof screenshots) chain into
 * one gallery instead of four dead ends.
 */
export default function ImageGrid({
  images,
  altPrefix = "Image",
  singleClassName,
}: {
  images: string[];
  altPrefix?: string;
  /** Override for the solitary-image render (e.g. ProofCard's full-width hero). */
  singleClassName?: string;
}) {
  const [lightbox, setLightbox] = useState<{
    images: string[];
    index: number;
  } | null>(null);

  if (!images || images.length === 0) return null;

  /** Collect every lightbox-able image in this pane, in transcript order,
   * and open the viewer at the clicked one (fallback: just this grid). */
  const openFrom = (el: HTMLImageElement, fallbackIndex: number) => {
    const root = el.closest("[data-pane-root]") ?? document;
    const nodes = Array.from(
      root.querySelectorAll<HTMLImageElement>("img[data-lb]")
    );
    const domIndex = nodes.indexOf(el);
    if (domIndex >= 0) {
      setLightbox({ images: nodes.map((n) => n.src), index: domIndex });
    } else {
      setLightbox({ images, index: fallbackIndex });
    }
  };

  const thumb = (src: string, i: number, className: string) => (
    <img
      key={i}
      src={src}
      alt={images.length > 1 ? `${altPrefix} ${i + 1}` : altPrefix}
      data-lb=""
      role="button"
      tabIndex={0}
      className={className}
      onClick={(e) => openFrom(e.currentTarget, i)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openFrom(e.currentTarget, i);
        }
      }}
    />
  );

  return (
    <>
      {images.length === 1 ? (
        thumb(
          images[0],
          0,
          singleClassName ||
            "max-h-80 w-auto max-w-full rounded border border-vscode-border cursor-zoom-in"
        )
      ) : (
        <div className="img-grid">
          {images.map((src, i) =>
            thumb(
              src,
              i,
              "img-cell rounded border border-vscode-border cursor-zoom-in"
            )
          )}
        </div>
      )}
      {lightbox && (
        <Lightbox
          images={lightbox.images}
          initialIndex={lightbox.index}
          altPrefix={altPrefix}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}
