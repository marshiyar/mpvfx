const WEB_LUT_URL_CHECK =
  't.protocol!=="http:"&&t.protocol!=="https:"?{error:"LUT must be project-local or a data URL"}:' +
  't.origin!==window.location.origin?{error:"Remote LUT URLs are not supported"}:{href:t.href}';
const ORIGINAL_LUT_URL_CHECK =
  'return t.protocol==="data:"?{href:t.href}:' + WEB_LUT_URL_CHECK;
const DESKTOP_LUT_URL_CHECK =
  'return t.protocol==="data:"?{href:t.href}:t.protocol==="mpvfx:"?' +
  't.protocol===window.location.protocol&&t.host===window.location.host?' +
  '{href:t.href}:{error:"Remote LUT URLs are not supported"}:' + WEB_LUT_URL_CHECK;

/** Project assets use the editor's protocol in Electron. Custom URL origins are
 * opaque, so compare both protocol and host before permitting a desktop LUT. */
export function enableStandaloneLutUrls(source: string): string {
  const originalCount = source.split(ORIGINAL_LUT_URL_CHECK).length - 1;
  const desktopCount = source.split(DESKTOP_LUT_URL_CHECK).length - 1;
  if (originalCount === 0 && desktopCount === 1) return source;
  if (originalCount !== 1 || desktopCount !== 0) {
    throw new Error("Standalone LUT URL boundary must occur exactly once");
  }
  return source.replace(ORIGINAL_LUT_URL_CHECK, DESKTOP_LUT_URL_CHECK);
}
