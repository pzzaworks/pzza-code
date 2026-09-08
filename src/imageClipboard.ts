// Start the clipboard write in the click gesture, including in WebKit.
export async function copyImageToClipboard(image: HTMLImageElement): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image copying requires clipboard access in the desktop app or a secure browser page.");
  }
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error("Wait for the image to finish loading.");
  if (image.naturalWidth * image.naturalHeight > 20_000_000) throw new Error("This image is too large to copy. Use an image smaller than 20 megapixels.");
  const png = new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image conversion is unavailable.");
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        canvas.width = canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error("Could not convert the image for copying."));
      }, "image/png");
    } catch (error) {
      canvas.width = canvas.height = 0;
      reject(error);
    }
  });
  // Conversion can fail before a browser rejects the clipboard operation.
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
