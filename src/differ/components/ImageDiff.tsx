import { locale } from "../../i18n";
import { T } from "../../i18n/differ";
import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent } from "react";
import { formatBytes, loadImage, type LoadedImage } from "../lib/images";
import { pixelDiff, type PixelDiffResult } from "../lib/pixeldiff";
import type { FileDiff } from "../types";

type Mode = "side" | "toggle" | "swipe" | "diff";

const MODES: { id: Mode; label: string; title: string }[] = [
  { id: "side", label: T.imageSideBySide, title: T.imageSideBySideHint },
  { id: "toggle", label: T.imageToggle, title: T.imageToggleHint },
  { id: "swipe", label: T.imageSlide, title: T.imageSlideHint },
  { id: "diff", label: T.imageDifference, title: T.imageDifferenceHint },
];

const MODE_KEY = "differ.imageMode";

function readMode(): Mode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (MODES.some((m) => m.id === saved)) return saved as Mode;
  } catch {
    // Storage unavailable: fall back to the default.
  }
  return "side";
}

/** Size of a box showing a `width`×`height` image: never upscaled, capped by width and by 70% of the viewport height. */
function boxStyle(width: number, height: number): CSSProperties {
  return { width: `min(100%, ${width}px, calc(70vh * ${width / height}))`, aspectRatio: `${width} / ${height}` };
}

/** Places an image inside a box sized for the bigger version, keeping both at the same scale. */
function layerStyle(image: LoadedImage, width: number, height: number): CSSProperties {
  return { width: `${(image.width / width) * 100}%`, height: `${(image.height / height) * 100}%` };
}

export function ImageDiff({ root, file }: { root: string; file: FileDiff }) {
  const [images, setImages] = useState<{ before: LoadedImage | null; after: LoadedImage | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(readMode);

  useEffect(() => {
    let cancelled = false;
    const load = (oid: string | null) => (oid ? loadImage(root, oid, file.path) : Promise.resolve(null));
    Promise.all([load(file.oldOid), load(file.newOid)])
      .then(([before, after]) => !cancelled && setImages({ before, after }))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [root, file]);

  const changeMode = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Not remembering the mode is fine.
    }
  };

  if (error) return <div className="file-note">{error}</div>;
  if (!images) return <div className="file-note">{T.loadingImage}</div>;

  const { before, after } = images;
  if (!before || !after) {
    const only = (before ?? after)!;
    return (
      <div className="image-diff">
        <div className="image-side single">
          <Frame image={only} kind={before ? "old" : "new"} label={before ? T.imageRemoved : T.imageAdded} />
        </div>
      </div>
    );
  }

  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const resized = before.width !== after.width || before.height !== after.height;

  return (
    <div className="image-diff">
      <div className="image-toolbar">
        <div className="segmented" role="group" aria-label={T.modeOfComparison}>
          {MODES.map((m) => (
            <button
              key={m.id}
              className={mode === m.id ? "active" : ""}
              title={m.title}
              onClick={() => changeMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {resized && (
          <span className="badge warn">
            {T.imageDimensionsChanged}: {before.width}×{before.height} → {after.width}×{after.height}
          </span>
        )}
      </div>
      {mode === "side" && (
        <div className="image-side">
          <Frame image={before} kind="old" label={T.before} />
          <Frame image={after} kind="new" label={T.after} />
        </div>
      )}
      {mode === "toggle" && <ToggleView before={before} after={after} width={width} height={height} />}
      {mode === "swipe" && <SwipeView before={before} after={after} width={width} height={height} />}
      {mode === "diff" && <PixelDiffView before={before} after={after} width={width} height={height} />}
    </div>
  );
}

interface CompareProps {
  before: LoadedImage;
  after: LoadedImage;
  width: number;
  height: number;
}

function Frame({ image, kind, label }: { image: LoadedImage; kind: "old" | "new"; label: string }) {
  return (
    <figure className={`image-frame ${kind}`}>
      <div className="image-box checker" style={boxStyle(image.width, image.height)}>
        <img src={image.url} alt={label} draggable={false} />
      </div>
      <Caption image={image} kind={kind} label={label} />
    </figure>
  );
}

function Caption({ image, kind, label }: { image: LoadedImage; kind: "old" | "new"; label: string }) {
  return (
    <figcaption className="image-caption">
      <span className={`image-label ${kind}`}>{label}</span>
      <span>
        {image.width} × {image.height}
      </span>
      <span>{formatBytes(image.size)}</span>
    </figcaption>
  );
}

function Stage({
  width,
  height,
  className,
  ...rest
}: { width: number; height: number; className: string } & HTMLAttributes<HTMLDivElement>) {
  return <div className={`image-box image-stage checker ${className}`} style={boxStyle(width, height)} {...rest} />;
}

/** Both versions in the same spot: hover a label to peek, click to keep it. */
function ToggleView({ before, after, width, height }: CompareProps) {
  const [pinned, setPinned] = useState<"old" | "new">("new");
  const [peek, setPeek] = useState<"old" | "new" | null>(null);
  const shown = peek ?? pinned;
  const image = shown === "old" ? before : after;

  const label = (side: "old" | "new", text: string) => (
    <button
      className={`image-label image-label-btn ${side}${shown === side ? " active" : ""}`}
      onMouseEnter={() => setPeek(side)}
      onMouseLeave={() => setPeek(null)}
      onClick={() => setPinned(side)}
    >
      {text}
    </button>
  );

  return (
    <div className="image-single">
      <div className="image-legend">
        {label("old", T.before)}
        {label("new", T.after)}
        <span className="muted">{T.peekPin}</span>
      </div>
      <Stage width={width} height={height} className={shown}>
        <img className="image-layer" src={image.url} style={layerStyle(image, width, height)} alt="" draggable={false} />
      </Stage>
      <Caption image={image} kind={shown} label={shown === "old" ? T.before : T.after} />
    </div>
  );
}

/** The new version drawn over the old one, revealed up to the handle. */
function SwipeView({ before, after, width, height }: CompareProps) {
  const [position, setPosition] = useState(50);
  const dragging = useRef(false);

  const moveTo = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setPosition(Math.min(100, Math.max(0, ((e.clientX - box.left) / box.width) * 100)));
  };

  return (
    <div className="image-single">
      <div className="image-legend">
        <span className="image-label old">{T.before}</span>
        <span className="muted">{T.imageDragOver}</span>
        <span className="image-label new">{T.after}</span>
      </div>
      <Stage
        width={width}
        height={height}
        className="swipe"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e);
        }}
        onPointerMove={(e) => dragging.current && moveTo(e)}
        onPointerUp={() => {
          dragging.current = false;
        }}
      >
        <img className="image-layer" src={before.url} style={layerStyle(before, width, height)} alt="" draggable={false} />
        <div className="image-layer full" style={{ clipPath: `inset(0 0 0 ${position}%)` }}>
          <img className="image-layer" src={after.url} style={layerStyle(after, width, height)} alt="" draggable={false} />
        </div>
        <div className="swipe-handle" style={{ left: `${position}%` }} />
      </Stage>
      <input
        className="swipe-range"
        type="range"
        min={0}
        max={100}
        step={0.1}
        value={position}
        onChange={(e) => setPosition(Number(e.target.value))}
        aria-label={T.positionDivider}
      />
    </div>
  );
}

function pixelsOf(image: LoadedImage) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image.element, 0, 0);
  return { data: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
}

/** Changed pixels in pink over the faded new version, with a box around the changed area. */
function PixelDiffView({ before, after, width, height }: CompareProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<PixelDiffResult | null>(null);

  useEffect(() => {
    const diff = pixelDiff(pixelsOf(before), pixelsOf(after));
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = diff.width;
      canvas.height = diff.height;
      canvas.getContext("2d")!.putImageData(new ImageData(diff.data, diff.width, diff.height), 0, 0);
    }
    setResult(diff);
  }, [before, after]);

  const percent = result ? (result.changed / result.total) * 100 : 0;
  const bounds = result?.bounds;

  return (
    <div className="image-single">
      <div className="image-legend">
        {result &&
          (result.changed === 0 ? (
            <span className="badge ok">{T.noPixelDiffers}</span>
          ) : (
            <span className="badge pink">
              {T.pixelsDifferent(
                result.changed.toLocaleString(locale()),
                percent.toLocaleString(locale(), { maximumFractionDigits: percent < 1 ? 3 : 1 }),
              )}
            </span>
          ))}
        <span className="muted">{T.emRosa}</span>
      </div>
      <Stage width={width} height={height} className="diff">
        <canvas ref={canvasRef} className="diff-canvas" />
        {bounds && (
          <div
            className="diff-bounds"
            style={{
              left: `${(bounds.x / width) * 100}%`,
              top: `${(bounds.y / height) * 100}%`,
              width: `${(bounds.width / width) * 100}%`,
              height: `${(bounds.height / height) * 100}%`,
            }}
          />
        )}
      </Stage>
    </div>
  );
}
