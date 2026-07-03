import { useEffect, useState } from "react";

/**
 * An inline image thumbnail that opens a full-size lightbox on click
 * (click anywhere or Esc to close). Used for screenshots in tool results
 * and proof cards.
 */
export default function ZoomableImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!zoomed) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setZoomed(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  return (
    <>
      <img
        src={src}
        alt={alt || "Screenshot"}
        role="button"
        tabIndex={0}
        className={
          className ||
          "max-h-72 w-auto max-w-full rounded border border-vscode-border cursor-zoom-in"
        }
        onClick={() => setZoomed(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setZoomed(true);
          }
        }}
      />
      {zoomed && (
        <div
          role="dialog"
          aria-label={alt || "Screenshot (full size)"}
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setZoomed(false)}
        >
          <img
            src={src}
            alt={alt || "Screenshot"}
            className="max-w-full max-h-full rounded shadow-2xl"
          />
        </div>
      )}
    </>
  );
}
