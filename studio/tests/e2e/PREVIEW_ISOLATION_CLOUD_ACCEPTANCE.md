# Cloud continuation acceptance: PR 72 editor recovery

Branch: `cloud/pr72-editor-recovery`, based on PR 72 at `0762d6457b9105210e876df64a2fca9f4b1b1a50`. Remote checkpoint `09c516549aaf9922539bb27bae599be4cdd1be6f` was pushed to this separate branch. PR 72 and PR 74 were not changed. Later local commits require separate verification and Mac patch reconciliation.

The pre-isolation comparison point is `5a0eabf`. This checkpoint addresses bounded, source-bound GSAP editing while the separate uncommitted Mac Grade/Effects and crop work is reconciled. No Mac patch was available in this workspace.

| Action | Source and runtime result | Packaged GUI result |
| --- | --- | --- |
| Read existing `from` and `fromTo` tweens | Real GSAP runtime observation now carries bounded method and explicit start values; a unique authored source call must agree before an edit is offered. | Scenario scripted, blocked before editor startup on this Linux host. |
| Add `from` or `fromTo` tween | The source writer inserts an explicit method, target, position, duration, value, optional start value, and selected ease. Parsing verifies the new call; a CAS write and Undo history entry own the change. | Scenario scripted for `fromTo`, blocked before startup. |
| Edit `fromTo` start value | The explicit start object is edited without replacing the destination or ease. Exact source/runtime shape and CAS checks run before commit. | Scenario scripted, blocked before startup. |
| Edit flat tween easing | The allowed set is `none`, power1–4, sine, expo, and circ, with in/out/inOut directions. The source parser verifies the saved ease. Unsupported or dynamic easing is left in source and shown read-only. | Scenario scripted, blocked before startup. |
| Read and edit a literal motion path point | A simple noncubic path with numeric `{x,y}` points, uniform curviness, and optional autoRotate must match the live MotionPathPlugin tween. The writer changes one existing point; source parsing verifies it. Plugin settings outside this shape mark the runtime observation incomplete. | Scenario scripted, blocked before startup. |
| Edit numeric GSAP channels | The source editor accepts every numeric channel in the bounded preview protocol instead of only seven transforms. Exact source/runtime values must agree. | New animation channel selector is present in source UI; packaged interaction untested. |
| Edit one literal keyframe ease | A selected existing percentage keyframe can receive `none`, power1–4, sine, expo, or circ with in/out/inOut. The source writer retains numeric values and parsing verifies the selected frame's ease and unchanged values before CAS and Undo history. | Source/inspector tests pass; packaged interaction untested. |
| Insert or remove an interior simple motion waypoint | Existing source and real MotionPathPlugin runtime must agree on one noncubic path. Add keeps at most 64 points; remove keeps both endpoints and at least two points. The rewritten points, uniform curviness, and autoRotate are checked before CAS and Undo history. | Source, runtime round-trip, and inspector tests pass; packaged interaction untested. |

The existing keyframe editor still supports literal percentage keyframes with numeric values. Motion-path editing is limited to simple existing points and interior insert/remove. Dynamic selectors, loops, reused helper calls, cubic paths, nonnumeric CSS properties, and arbitrary GSAP plugin configuration are outside this bounded path. These are functional reductions from the old same-origin editor and need a product decision before redesign or removal is treated as accepted parity.

Audit against `5a0eabf`: the old `AnimationCard` exposed per-keyframe easing, string property rows (`filter`, `clipPath`, color, and more), and arc path controls. Its dynamic selector fallback in `useGsapTweenCache` pairs unresolved source animations with runtime elements by iteration index, falling back to the first call. That can identify the wrong source call. The old writer supports arc path toggles and segment changes, but custom cubic controls and curve conversion are outside the current runtime/source equality model. Simple interior point count changes are now checked against real GSAP. The preview protocol only admits numeric GSAP channels; `gsapObservation.scalarProperties` marks a tween with `color`, `filter`, or `clipPath` incomplete. A bounded next step for nonnumeric editing would need typed runtime values and exact source/runtime comparison, starting with a small literal color subset. Arbitrary CSS strings should remain read-only until their parser and runtime semantics are modeled.

An explicit dynamic selector binding is possible only with new provenance: a stable literal author-supplied tween ID, runtime evidence that the call produced exactly one tween targeting exactly one element, and a source parser check that the ID occurs once. The existing observation carries the runtime ID but not the total target count or source invocation count. Choosing whether to require authors to add this ID, or to offer a reviewed materialization of each runtime target into literal source calls, is a product decision. Neither path should reuse the old iteration-order guess.

## Mac reconciliation checklist

1. Preserve the Mac working tree first. Compare its diff with cloud commits `09c5165`, `6639d8d`, and the later local motion-path commit; inspect overlapping GSAP and inspector files before applying either patch. PR 72 and PR 74 are stacked and still unmerged.
2. On disposable projects, exercise the detailed native and legacy Grade/Effects controls from the Mac patch; verify individual value changes, Undo/Redo, save/reopen, and seeked preview. Do not infer animated persistence from a frame-zero screenshot.
3. Exercise `from`, `fromTo`, flat and per-keyframe easing, numeric channels, and simple motion-path point move/insert/remove. After each action, verify the authored source, Undo/Redo, reopened project, and live values at representative seek times. Keep dynamic selectors, nonnumeric properties, cubic paths, and unknown plugin settings read-only pending explicit scope decisions.
4. Verify native crop rotation at a non-key frame without requiring new native x/y tracks, then save/reopen and inspect a seeked frame. Native FFmpeg Grade/FX export was already unsupported and is not an acceptance target.
5. Run Mac source/security/runtime tests and the actual packaged Mac GUI scenarios. Cloud source/runtime tests and the Linux package do not establish Mac GUI parity. Keep v0.0.7, PR heads, and existing projects unchanged until the integration is reviewed.

The packaged Linux app was built and passed Forge's post-package checks. For this disposable test package only, a Debian Chromium headless shell substituted for Puppeteer's blocked Chrome download; this does not validate the intended export browser. The GUI scenario stopped before opening a project because the packaged Electron SUID sandbox helper requires root ownership and mode 4755. Sandbox settings were not changed. Mac GUI behavior remains untested from this cloud environment.

Run the packaged scenario on a host with a correctly configured Electron sandbox:

```sh
cd studio
MPVFX_PACKAGED_APP=/absolute/path/to/MpVFX node tests/e2e/preview-isolation-gsap-advanced-cloud.mjs
```

The scenario creates disposable projects and profiles under the system temporary directory. It checks saved source and live GSAP values at two seconds and writes screenshots plus `evidence.json` there. Screenshots alone are not treated as evidence of animation persistence.
