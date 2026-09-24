import type { ShareCardPlan } from './shareCard';

// The native half of the picture export, which is that there is not one.
//
// Drawing the card needs a canvas, and saving or sharing the result needs a
// file system and a share sheet — `expo-file-system`, `expo-sharing` and
// `react-native-view-shot` are all absent, and adding any of them is a native
// rebuild rather than a JavaScript change. So the app says so: `PNG_SUPPORTED`
// is false here, the export modal draws no picture section on a phone, and the
// position text — which is the half that works everywhere — is offered exactly
// as it is on the web.
//
// Deliberately not a throwing stub. A button that exists and fails is worse
// than a button that was never drawn, and the modal has a real answer either
// way. See `./shareImage.web.ts` for the half that does the work.

export const PNG_SUPPORTED = false;

export interface RenderOptions {
  scale?: number;
}

const unsupported = (): never => {
  throw new Error('Saving the board as a picture is only available on the web.');
};

export const shareCardDataURL = async (
  _plan: ShareCardPlan,
  _options?: RenderOptions,
): Promise<string> => unsupported();

export const downloadShareCard = async (
  _plan: ShareCardPlan,
  _filename: string,
  _options?: RenderOptions,
): Promise<void> => unsupported();

export const copyShareCard = async (
  _plan: ShareCardPlan,
  _options?: RenderOptions,
): Promise<void> => unsupported();
