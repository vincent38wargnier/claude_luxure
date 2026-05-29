interface ThumbnailsProps {
  images: string[];
  onRemove?: (index: number) => void;
}

export default function Thumbnails({ images, onRemove }: ThumbnailsProps) {
  if (images.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-1.5 flex-wrap mb-2">
      {images.map((img, i) => (
        <div key={i} className="relative group/thumb">
          <img
            src={img}
            alt={`Attachment ${i + 1}`}
            className="h-16 w-auto rounded border border-vscode-border object-cover"
          />
          {onRemove && (
            <button
              onClick={() => onRemove(i)}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-vscode-errorFg text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
