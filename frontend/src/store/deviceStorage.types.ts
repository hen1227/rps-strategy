/**
 * The little of a browser's `Storage` this app actually uses.
 *
 * Declared apart from either implementation so that both must satisfy the same
 * type. Platform files are resolved by the bundler and never see each other,
 * so a shared declaration is the only thing that can keep them in step.
 */
export interface DeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
