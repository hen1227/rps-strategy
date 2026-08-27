// Asking the person at the keyboard for a picture.
//
// Split by platform the way `deviceStorage` and `discordAuth` are, because the
// web has a file input and a native build does not. No Expo module: the whole
// consumer is a browser workbench, and pulling in a picker — with its
// permission strings and its own upgrade cadence — to wrap `<input type=file>`
// would be a dependency bought for one line.

export interface PickedImage {
  name: string;
  /** The file, base64, no `data:` prefix — the shape `addImage` takes. */
  data: string;
  size: number;
}

/** Ask for a picture. Resolves null when the person cancels. */
export type PickImage = () => Promise<PickedImage | null>;

/**
 * The payload of a `data:` URL, or nothing.
 *
 * Split out and pure because it is the only part of the picker that can be
 * tested at all: the `.mts` harness has no DOM.
 */
export const dataURLPayload = (value: string): string | null => {
  if (!value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const header = value.slice(5, comma);
  if (!header.includes(';base64')) return null;
  const payload = value.slice(comma + 1);
  return payload === '' ? null : payload;
};
