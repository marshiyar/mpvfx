/** Real native-window commands, using only production controls and saved files. */
export async function verifyProfessionalTimeline({
  page,
  readSaved,
  selectByDomId,
  requestSeek,
  waitUntil,
  assert,
}) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const chord = async (key) => {
    await page.keyboard.down(modifier);
    await page.keyboard.press(key);
    await page.keyboard.up(modifier);
  };
  const clips = (doc) => doc.sequence.tracks.flatMap((track) => track.clips);
  const readClips = async () => clips(await readSaved());
  const original = (await readClips()).find((clip) => clip.binding.domId === "native-video");
  assert(original, "Professional workflow requires the saved animated clip");
  const values = (clip) =>
    clip.parameterTracks.map((track) => ({
      parameterId: track.parameterId,
      keys: track.keyframes.map((key) => ({
        frame: key.frame,
        value: key.value,
        outgoing: key.outgoing,
      })),
    }));
  const initial = JSON.stringify(values(original));
  const context = async (id, label) => {
    await selectByDomId(page, id, false);
    const clip = await page.waitForSelector(`pierce/[data-clip="true"][data-el-id$="#${id}"]`);
    await clip.click({ button: "right" });
    await page.waitForSelector('pierce/[role="menuitem"]');
    for (const item of await page.$$('pierce/[role="menuitem"]')) {
      const text = await item.evaluate((el) => el.textContent.trim());
      if (text === label || text.startsWith(`${label}⌘`)) {
        await item.click();
        return;
      }
    }
    throw new Error(`Missing clip command: ${label}`);
  };

  // The selected grouped diamond copies all of its scalar channels, and Delete
  // after paste must delete those keys without falling through to clip deletion.
  await selectByDomId(page, "native-video", false);
  const diamond = await page.waitForSelector(
    'pierce/[data-keyframe-group="position"][data-keyframe-percentage="0"]',
  );
  await diamond.click();
  await chord("c");
  await requestSeek(page, 1);
  await chord("v");
  await waitUntil(
    async () =>
      (await readClips())[0].parameterTracks.some(
        (track) =>
          track.parameterId === "transform.position.x" &&
          track.keyframes.some((key) => key.frame === 30),
      ),
    "Keyframe paste did not anchor at the playhead",
  );
  await page.waitForSelector(
    'pierce/[data-keyframe-group="position"][data-keyframe-percentage="25"][data-keyframe-selected="true"]',
  );
  await page.keyboard.press("Delete");
  await waitUntil(
    async () =>
      (await readClips()).length === 1 &&
      !(await readClips())[0].parameterTracks.some((track) =>
        track.keyframes.some((key) => key.frame === 30),
      ),
    "Delete did not stay scoped to pasted keyframes",
  );
  await chord("z");
  await waitUntil(
    async () =>
      (await readClips())[0].parameterTracks.some((track) =>
        track.keyframes.some((key) => key.frame === 30),
      ),
    "Undo did not restore pasted keys",
  );
  await chord("z");
  await waitUntil(
    async () => JSON.stringify(values((await readClips())[0])) === initial,
    "Undo paste did not restore the original animation",
  );

  await context("native-video", "Copy");
  await requestSeek(page, 4);
  await chord("v");
  await waitUntil(
    async () => (await readClips()).length === 2,
    "Clip paste did not create an independent native clip",
  );
  const pasted = (await readClips()).find((clip) => clip.id !== original.id);
  assert(
    pasted.startFrame === 120 && JSON.stringify(values(pasted)) === initial,
    "Clip copy lost animation or playhead timing",
  );
  assert(
    pasted.parameterTracks.every((track, i) => track.id !== original.parameterTracks[i].id),
    "Copied animation still shares editable identities",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectByDomId(page, pasted.binding.domId, false);
  await context(pasted.binding.domId, "Cut");
  await waitUntil(
    async () => (await readClips()).length === 1,
    "Cut did not remove the selected clip",
  );
  await chord("z");
  await waitUntil(
    async () => (await readClips()).length === 2,
    "Undo Cut did not restore both clip and animation",
  ).catch(async (error) => {
    console.log(
      "PROFESSIONAL_CUT_UNDO_STATE",
      JSON.stringify(
        (await readClips()).map((clip) => ({
          id: clip.id,
          start: clip.startFrame,
          duration: clip.durationFrames,
        })),
      ),
    );
    throw error;
  });

  await context("native-video", "Duplicate");
  await waitUntil(
    async () => (await readClips()).length === 3,
    "Duplicate command did not save an independent clip",
  );
  await chord("z");
  await waitUntil(
    async () => (await readClips()).length === 2,
    "Undo Duplicate did not restore the clip set",
  );

  await selectByDomId(page, "native-video", false);
  await requestSeek(page, 1.5);
  await page.keyboard.press("s");
  await waitUntil(
    async () => (await readClips()).length === 3,
    "Split did not commit both native halves",
  );
  const split = await readClips();
  const left = split.find((clip) => clip.id === original.id);
  const right = split.find((clip) => clip.startFrame === 45);
  assert(
    left.durationFrames === 45 && JSON.stringify(values(left)) === initial,
    "Split cropped the left animation handles",
  );
  assert(right && right.durationFrames === 75, "Split changed the visible range");
  const expectedRight = values(original).map((track) => ({
    ...track,
    keys: track.keys.map((key) => ({ ...key, frame: key.frame - 45 })),
  }));
  assert(
    JSON.stringify(values(right)) === JSON.stringify(expectedRight),
    "Split failed to retain all right-side channels and interpolation",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectByDomId(page, right.binding.domId, false);
  const reopened = await readClips();
  assert(
    JSON.stringify(values(reopened.find((clip) => clip.id === right.id))) ===
      JSON.stringify(expectedRight),
    "Reopen discarded hidden animation handles",
  );
  await chord("a");
  await page.keyboard.press("Delete");
  await waitUntil(
    async () => (await readClips()).length === 0,
    "Select All / Delete did not delete all selected clips",
  );
  await chord("z");
  await waitUntil(
    async () => (await readClips()).length === 3,
    "Undo Delete All did not restore every clip",
  );
  console.log(
    "PASS professional timeline: keyframe clipboard, scoped deletion, clip clipboard, cut, duplicate, complete-curve split, reopen, select all, delete all and atomic undo",
  );
}
