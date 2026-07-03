import ZoomableImage from "./ZoomableImage";

/**
 * Images inside a chat message. A single image keeps its natural aspect ratio
 * (height-capped, like before); two or more become uniform tiles in a grid
 * whose column count follows the chat panel's real width via container
 * queries (see .img-grid in index.css): 1 column in a narrow sidebar,
 * 2 from 440px, 3 from 760px. Every tile zooms to full size on click.
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
  if (!images || images.length === 0) return null;

  if (images.length === 1) {
    return (
      <ZoomableImage
        src={images[0]}
        alt={altPrefix}
        className={
          singleClassName ||
          "max-h-80 w-auto max-w-full rounded border border-vscode-border cursor-zoom-in"
        }
      />
    );
  }

  return (
    <div className="img-grid">
      {images.map((src, i) => (
        <ZoomableImage
          key={i}
          src={src}
          alt={`${altPrefix} ${i + 1}`}
          className="img-cell rounded border border-vscode-border cursor-zoom-in"
        />
      ))}
    </div>
  );
}
