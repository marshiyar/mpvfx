/** The retained composition runtime renders GSAP even while paused. Complete
 * each of those passes with the native picture, without another transport seek.
 * Keep this compatibility patch version-checked, like the media transport patch. */
export function coordinateNativePreviewRuntime(source: string): string {
  const boundary = 'catch(D){L("runtime.init.transport.adapter",D)}}let Nm=';
  if (source.split(boundary).length !== 2) {
    throw new Error("Native picture runtime boundary must occur exactly once");
  }
  const opacityBoundary = 'e.sourceOpacityForCanvas=u.opacity||"1"';
  const opacityRestore = 'a&&!s&&(e.sourceInlineOpacity!==null?';
  let pictureSource = source;
  if (source.includes(opacityBoundary)) {
    if (source.split(opacityRestore).length !== 2) {
      throw new Error("Graded source opacity restore must occur exactly once");
    }
    // Style edits change the authored stamp while grading keeps the source
    // hidden. Refresh the cached baseline before the next shader redraw.
    pictureSource = source.replace(opacityRestore,
      'a&&!s&&(e.element.hasAttribute("data-hf-authored-opacity")&&(e.sourceInlineOpacity=e.element.getAttribute("data-hf-authored-opacity")||null,e.sourceInlineOpacityPriority=""),e.sourceInlineOpacity!==null?')
      .replace(opacityBoundary,
      'e.sourceOpacityForCanvas=e.element.getAttribute("data-studio-native-opacity")??(u.opacity||"1")');
  }
  return pictureSource.replace(boundary,
    'catch(D){L("runtime.init.transport.adapter",D)}window.__studioNativePlayer?.reapplyFrame?.()}let Nm=');
}
