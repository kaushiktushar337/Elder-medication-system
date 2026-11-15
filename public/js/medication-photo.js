export async function resizeMedicationPhoto(file) {
  if (!file.type.startsWith('image/') || file.size > 12_000_000) throw new Error('Choose an image under 12 MB.');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(1, 620 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [.82, .65, .48]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (jpeg && jpeg.length <= 166_000) return jpeg;
    }
    throw new Error('The compressed photo is still too large.');
  } finally {
    URL.revokeObjectURL(source);
  }
}
