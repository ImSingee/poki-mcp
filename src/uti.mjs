// Off macOS there is no UTType registry to ask whether a pasteboard type is an image, so the
// image types an iPhone puts on its pasteboard are listed here. Apple's image types that are not
// listed end in "-image" (public.camera-raw-image, public.svg-image, com.adobe.raw-image, ...).
const imageTypes = new Set([
  'public.image', 'public.png', 'public.jpeg', 'public.jpeg-2000', 'public.tiff', 'public.heic',
  'public.heics', 'public.heif', 'public.avif', 'public.avis', 'public.pbm', 'public.pvr',
  'public.radiance', 'public.webp', 'com.compuserve.gif', 'com.microsoft.bmp', 'com.microsoft.ico',
  'com.apple.icns', 'com.apple.pict', 'com.adobe.photoshop-image', 'com.ilm.openexr-image',
  'com.truevision.tga-image', 'org.webmproject.webp', 'org.khronos.ktx', 'org.khronos.ktx2',
  'com.apple.private.astc', 'org.khronos.astc', 'public.dng',
]);

export function containsImage(types) {
  return types.some(type => imageTypes.has(type) || type.endsWith('-image'));
}
