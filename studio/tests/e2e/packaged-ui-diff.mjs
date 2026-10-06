import { decodePng, encodePng } from "./png-rgba.mjs";

/** Compare the actual packaged screenshots and layout measurements. */
export function comparePackagedUi(oldPng, newPng, oldLayout, newLayout) {
  const oldImage = decodePng(oldPng);
  const newImage = decodePng(newPng);
  const size = { width: oldImage.width, height: oldImage.height };
  if (size.width !== newImage.width || size.height !== newImage.height)
    throw new Error(`Packaged screenshot size changed: ${JSON.stringify({ oldSize: size, newSize: { width: newImage.width, height: newImage.height } })}`);
  const diff = Buffer.alloc(oldImage.rgba.length);
  let changedPixels = 0;
  for (let index = 0; index < diff.length; index += 4) {
    const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(oldImage.rgba[index + channel] - newImage.rgba[index + channel])));
    if (delta > 24) changedPixels++;
    diff[index] = delta > 24 ? 255 : 0;
    diff[index + 1] = 0;
    diff[index + 2] = delta > 24 ? 255 : 0;
    diff[index + 3] = 255;
  }
  const shiftedLayoutFields = Object.keys(oldLayout).filter(key => Math.abs(oldLayout[key] - newLayout[key]) > 4);
  const changedPercent = 100 * changedPixels / (size.width * size.height);
  return {
    size, changedPixels, changedPercent, shiftedLayoutFields,
    diffPng: encodePng(size.width, size.height, diff),
    accepted: !shiftedLayoutFields.length && changedPercent <= 2,
  };
}
