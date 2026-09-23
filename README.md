# MpVFX


## macOS Running the app issue

quarantine blocks the option to “Open Anyway” because the build is an ad hoc signed, unnotarized Electron bundle. This outcome is expected at this stage, yet we must resolve it moving forward. In the future, we will need to sign builds for every operating system we plan to support.

Quick fix on macOS to run anyway:
* move the app to Applications
* xattr -dr com.apple.quarantine /Applications/MpVFX.app

if above gives permission error use:
* sudo xattr -dr com.apple.quarantine /Applications/MpVFX.app
