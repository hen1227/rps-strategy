import type { PickedImage, PickImage } from './pickImage.types';

export type { PickedImage } from './pickImage.types';

/**
 * Nothing, on a native build.
 *
 * `/lab` is an ordinary route, so it *is* reachable on a phone — but there is no
 * file input there and no picker dependency in this app. The UI checks the
 * platform and does not offer the button, so this exists to keep the import
 * resolvable rather than to be called.
 */
export const pickImage: PickImage = async (): Promise<PickedImage | null> => null;
