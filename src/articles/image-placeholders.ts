/** Remove decorative image placeholders that otherwise mask the real media. */
type QueryableDocument = {
  querySelectorAll(selector: string): {
    forEach(callback: (image: { remove(): void }) => void): void;
  };
};

export function removeImagePlaceholders(document: QueryableDocument): void {
  document.querySelectorAll('img[data-image-placeholder]:not([data-image-placeholder-media])')
    .forEach((image) => image.remove());
}
