// ── GIF support ───────────────────────────────────────────────────────────────
// Detects, loads, and provides GIF elements. GIFs are treated as animated images
// — they load via data URL (like images, not videos) and always render.

// Detect if a file is a GIF by extension or MIME type.
export function isGif(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ext === 'gif' || file.type === 'image/gif';
}

// Load a GIF file and return a promise that resolves to { el, type: 'gif' }.
// Follows the same data-URL pattern as static images for iOS Safari compatibility.
export function loadGif(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Return image element + type marker. Modern browsers animate GIFs in
        // <img> elements automatically — no special decoding needed.
        resolve({ el: img, type: 'gif' });
      };
      img.onerror = () => {
        reject(new Error('Failed to render GIF'));
      };
      img.src = reader.result;  // data:image/gif;base64,...
    };
    reader.onerror = () => {
      reject(new Error('Could not read GIF file'));
    };
    reader.readAsDataURL(file);
  });
}

// Check if a media element is a GIF (for render and UI logic).
export function isGifMedia(media) {
  return media && media.type === 'gif';
}