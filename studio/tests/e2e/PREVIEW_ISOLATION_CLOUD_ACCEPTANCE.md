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

The existing keyframe editor still supports literal percentage keyframes with numeric values. It does not add/remove motion path points. Dynamic selectors, loops, reused helper calls, cubic paths, nonnumeric CSS properties, and arbitrary GSAP plugin configuration are outside this bounded path. These are functional reductions from the old same-origin editor and need a product decision before redesign or removal is treated as accepted parity.

Audit against `5a0eabf`: the old `AnimationCard` exposed per-keyframe easing, string property rows (`filter`, `clipPath`, color, and more), and arc path controls. Its dynamic selector fallback in `useGsapTweenCache` pairs unresolved source animations with runtime elements by iteration index, falling back to the first call. That can identify the wrong source call. The old writer path supports arc path toggles, segment changes, and point count mutations, but these modify curve structure and have not been checked against the isolated runtime shape for this checkpoint. Explicit source/runtime matched per-keyframe easing is the bounded recovery above; the other capabilities need separately evidenced designs or explicit scope decisions.

The packaged Linux app was built and passed Forge's post-package checks. For this disposable test package only, a Debian Chromium headless shell substituted for Puppeteer's blocked Chrome download; this does not validate the intended export browser. The GUI scenario stopped before opening a project because the packaged Electron SUID sandbox helper requires root ownership and mode 4755. Sandbox settings were not changed. Mac GUI behavior remains untested from this cloud environment.

Run the packaged scenario on a host with a correctly configured Electron sandbox:

```sh
cd studio
MPVFX_PACKAGED_APP=/absolute/path/to/MpVFX node tests/e2e/preview-isolation-gsap-advanced-cloud.mjs
```

The scenario creates disposable projects and profiles under the system temporary directory. It checks saved source and live GSAP values at two seconds and writes screenshots plus `evidence.json` there. Screenshots alone are not treated as evidence of animation persistence.
