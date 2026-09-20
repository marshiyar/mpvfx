/** The retained composition runtime renders GSAP even while paused. Complete
 * each of those passes with the native picture, without another transport seek.
 * Keep this compatibility patch version-checked, like the media transport patch. */
export function coordinateNativePreviewRuntime(source: string): string {
  const boundary = 'catch(D){L("runtime.init.transport.adapter",D)}}let Nm=';
  if (source.split(boundary).length !== 2) {
    throw new Error("Native picture runtime boundary must occur exactly once");
  }
  const opacityBoundary = 'e.sourceOpacityForCanvas=u.opacity||"1"';
  const pictureSource = source.includes(opacityBoundary)
    ? source.replace(opacityBoundary,
      'e.sourceOpacityForCanvas=e.element.getAttribute("data-studio-native-opacity")??(u.opacity||"1")')
    : source;
  return pictureSource.replace(boundary,
    'catch(D){L("runtime.init.transport.adapter",D)}window.__studioNativePlayer?.reapplyFrame?.()}let Nm=');
}
