import { Asset } from 'expo-asset';
import type { ImageSourcePropType } from 'react-native';

import { pieceSetById } from '@/appearance/pieceSets';
import { useAppearanceStore } from '@/appearance/store';
import { players } from '@/theme';
import type { PlayablePiece, SideColor } from '@/types/game';

import type { CardShape, ShareCardPlan } from './shareCard';

// The plan, painted.
//
// Canvas rather than a screenshot of the live board: there is no screenshot API
// here — `react-native-view-shot` is not a dependency and adding one would mean
// a native rebuild — and a screenshot would be the wrong picture anyway. It
// would carry whatever the viewer had selected, whatever arrow the engine was
// drawing, and the device's own pixel ratio. This draws the position, at a
// size chosen for where it is going.
//
// Web only. The native half of this module says so rather than throwing, and
// the export modal offers no picture where it cannot make one — see
// `./shareImage.ts`.

export const PNG_SUPPORTED = true;

/** Two, so a nine by nine board lands at 1080 across. */
const DEFAULT_SCALE = 2;

const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Artwork already fetched, keyed by its URL.
 *
 * A board is eighteen pieces drawn from at most six pictures, and the preview
 * is redrawn on every switch the modal offers, so without this a single session
 * with the dialog open would ask the browser for the same six files forty
 * times. `null` is remembered too: a picture that will not load is not worth
 * retrying once per redraw.
 */
const artwork = new Map<string, HTMLImageElement | null>();

const loadArtwork = async (uri: string): Promise<HTMLImageElement | null> => {
  const cached = artwork.get(uri);
  if (cached !== undefined) return cached;
  const image = new window.Image();
  image.src = uri;
  const loaded = await image
    .decode()
    .then(() => image)
    .catch(() => null);
  artwork.set(uri, loaded);
  return loaded;
};

/**
 * Where a piece's artwork is served from.
 *
 * A catalogue entry is whatever `require` of a PNG produced, which is a
 * registered asset id under Metro and a plain URL under some other bundler, so
 * all three shapes are answered rather than assumed. Anything else — the array
 * form, a source with no `uri` — is no picture, and no picture is a letter.
 */
const assetURI = async (source: ImageSourcePropType): Promise<string | null> => {
  if (typeof source === 'string') return source;
  if (typeof source === 'number') {
    const asset = Asset.fromModule(source);
    return asset.localUri ?? asset.uri ?? (await asset.downloadAsync()).uri ?? null;
  }
  if (source && typeof source === 'object' && 'uri' in source) return source.uri ?? null;
  return null;
};

/** Every picture the plan needs, resolved once before anything is painted. */
const collectArtwork = async (plan: ShareCardPlan) => {
  const set = pieceSetById(useAppearanceStore.getState().appearance.pieces);
  const wanted = new Map<string, { color: SideColor; piece: PlayablePiece }>();
  for (const shape of plan.shapes) {
    if (shape.kind !== 'piece') continue;
    wanted.set(`${shape.color}:${shape.piece}`, { color: shape.color, piece: shape.piece });
  }
  const pictures = new Map<string, HTMLImageElement | null>();
  await Promise.all(
    Array.from(wanted, async ([key, { color, piece }]) => {
      const source = set.raster[color][piece.toLowerCase()];
      if (!source) {
        pictures.set(key, null);
        return;
      }
      try {
        const uri = await assetURI(source);
        pictures.set(key, uri ? await loadArtwork(uri) : null);
      } catch {
        // The same answer a board gives: no picture, so draw the letter.
        pictures.set(key, null);
      }
    }),
  );
  return pictures;
};

const roundedPath = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const limit = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + limit, y);
  context.arcTo(x + width, y, x + width, y + height, limit);
  context.arcTo(x + width, y + height, x, y + height, limit);
  context.arcTo(x, y + height, x, y, limit);
  context.arcTo(x, y, x + width, y, limit);
  context.closePath();
};

/**
 * A piece with no artwork: the filled disc carrying its initial that `PieceIcon`
 * falls back to, so a picture that will not load costs a letter rather than a
 * hole. Eighteen holes on an otherwise correct board reads as a broken export.
 */
const drawLetterPiece = (
  context: CanvasRenderingContext2D,
  { x, y, size, color, piece }: Extract<CardShape, { kind: 'piece' }>,
) => {
  const palette = players[color];
  context.beginPath();
  context.arc(x + size / 2, y + size / 2, size / 2 - 1, 0, Math.PI * 2);
  context.fillStyle = palette.strong;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = palette.border;
  context.stroke();
  context.fillStyle = palette.contrast;
  context.font = `900 ${size * 0.56}px ${FONT_STACK}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(piece.charAt(0), x + size / 2, y + size / 2);
};

const paint = (
  context: CanvasRenderingContext2D,
  plan: ShareCardPlan,
  pictures: Map<string, HTMLImageElement | null>,
) => {
  context.fillStyle = plan.background;
  context.fillRect(0, 0, plan.width, plan.height);

  for (const shape of plan.shapes) {
    switch (shape.kind) {
      case 'rect': {
        // Half-pixel inset on a stroke, so a one-point border lands on a pixel
        // instead of straddling two and coming out grey at both.
        const inset = shape.stroke ? (shape.strokeWidth ?? 1) / 2 : 0;
        roundedPath(
          context,
          shape.x + inset,
          shape.y + inset,
          shape.width - inset * 2,
          shape.height - inset * 2,
          shape.radius ?? 0,
        );
        if (shape.fill) {
          context.fillStyle = shape.fill;
          context.fill();
        }
        if (shape.stroke) {
          context.lineWidth = shape.strokeWidth ?? 1;
          context.strokeStyle = shape.stroke;
          context.stroke();
        }
        break;
      }
      case 'text': {
        context.font = `${shape.weight ?? 400} ${shape.size}px ${
          shape.mono ? MONO_STACK : FONT_STACK
        }`;
        context.fillStyle = shape.fill;
        context.textAlign = shape.align ?? 'left';
        context.textBaseline = 'middle';
        // Not every engine has `letterSpacing`; one that does not simply draws
        // the label untracked, which is a label rather than a missing one.
        const spaced = context as CanvasRenderingContext2D & { letterSpacing?: string };
        if (shape.tracking) spaced.letterSpacing = `${shape.tracking}px`;
        context.fillText(shape.text, shape.x, shape.y, shape.maxWidth);
        if (shape.tracking) spaced.letterSpacing = '0px';
        break;
      }
      case 'piece': {
        const picture = pictures.get(`${shape.color}:${shape.piece}`);
        if (picture) context.drawImage(picture, shape.x, shape.y, shape.size, shape.size);
        else drawLetterPiece(context, shape);
        break;
      }
    }
  }
};

export interface RenderOptions {
  /** Device pixels per point. The preview asks for one, an export for two. */
  scale?: number;
}

/** The card, on a canvas of its own, at `scale` times its laid-out size. */
export const renderShareCard = async (
  plan: ShareCardPlan,
  { scale = DEFAULT_SCALE }: RenderOptions = {},
): Promise<HTMLCanvasElement> => {
  const pictures = await collectArtwork(plan);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(plan.width * scale);
  canvas.height = Math.round(plan.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error("Could not create the image in this browser.");
  context.scale(scale, scale);
  paint(context, plan, pictures);
  return canvas;
};

/** The card as a data URL, which is what an `<Image>` preview wants. */
export const shareCardDataURL = async (plan: ShareCardPlan, options?: RenderOptions) =>
  (await renderShareCard(plan, options)).toDataURL('image/png');

export const shareCardBlob = async (plan: ShareCardPlan, options?: RenderOptions) => {
  const canvas = await renderShareCard(plan, options);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be encoded.'))),
      'image/png',
    );
  });
};

/** Hand the file to the browser's downloads, under a name worth keeping. */
export const downloadShareCard = async (
  plan: ShareCardPlan,
  filename: string,
  options?: RenderOptions,
) => {
  const blob = await shareCardBlob(plan, options);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Not revoked in the same tick: Safari has not finished with the URL when
  // `click` returns, and a revoked one downloads an empty file.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

/**
 * The picture itself on the clipboard, for pasting straight into a chat.
 *
 * Narrower support than the download: Firefox has no `ClipboardItem` for images
 * at all, so the caller is told rather than left with a button that looks like
 * it worked.
 */
export const copyShareCard = async (plan: ShareCardPlan, options?: RenderOptions) => {
  const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem })
    .ClipboardItem;
  if (!ClipboardItemCtor || !navigator.clipboard?.write) {
    throw new Error('This browser cannot put a picture on the clipboard. Download it instead.');
  }
  const blob = await shareCardBlob(plan, options);
  await navigator.clipboard.write([new ClipboardItemCtor({ 'image/png': blob })]);
};
