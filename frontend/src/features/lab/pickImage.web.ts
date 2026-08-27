import { dataURLPayload, type PickedImage, type PickImage } from './pickImage.types';

export type { PickedImage } from './pickImage.types';

/**
 * A file input, created and clicked inside the gesture that asked for it.
 *
 * Created per call rather than kept in the tree: a browser only honours
 * `click()` on a file input from inside a user gesture, and an input that lived
 * in the DOM would also have to be reset between picks so choosing the same
 * file twice still fires `change`.
 */
export const pickImage: PickImage = () =>
  new Promise<PickedImage | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.style.display = 'none';

    let settled = false;
    const finish = (picked: PickedImage | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(picked);
    };

    input.addEventListener('cancel', () => finish(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      const reader = new FileReader();
      reader.onerror = () => finish(null);
      reader.onload = () => {
        const payload =
          typeof reader.result === 'string' ? dataURLPayload(reader.result) : null;
        finish(payload ? { name: file.name, data: payload, size: file.size } : null);
      };
      reader.readAsDataURL(file);
    });

    document.body.appendChild(input);
    input.click();
  });
