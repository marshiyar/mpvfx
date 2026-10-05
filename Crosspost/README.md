# Cross-posting from MpVFX

This is alexanderphez's publishing contribution from PR #70. The editor's **Publish…** action on a completed export opens this existing GUI with the exported video selected. Review the destination, metadata, and visibility, then use **Start Cross-Posting** in the publisher to upload. Opening the publisher does not upload anything.

The tool currently supports YouTube and Facebook Pages. TikTok is not implemented.

## Local setup

Official MpVFX installers bundle a Python executable and the GUI dependencies inside the app's `Crosspost/bin` resources. No separate Python installation is needed for **Publish…** in those builds. You still need credentials for whichever destination you choose. A local source-only build, or a build made without `MPVFX_BUNDLE_CROSSPOST=1`, uses the external Python fallback below.

```sh
python3 -m venv Crosspost/.venv
Crosspost/.venv/bin/python -m pip install -r Crosspost/requirements.txt
export MPVFX_CROSSPOST_PYTHON="$PWD/Crosspost/.venv/bin/python"
```

Finder and desktop launches may not inherit a shell export. For those launches, create `python-path.txt` inside MpVFX's user-data `publishing` directory, containing the **absolute** path to that environment's Python executable on one line. The Publish error displays the exact path to this file and to this README for the installed app. The environment can live outside the application bundle so updates do not remove it.

For an editor launch, credentials live in the `publishing` subdirectory of MpVFX's user data directory. Put your Google desktop OAuth client configuration in `client_secrets.json`. For Facebook, `facebook_credentials.json` must contain your `page_id` and `access_token`. YouTube's resulting `token.json` stays in that directory too. Standalone use defaults to the current directory, or accepts `MPVFX_CROSSPOST_CONFIG_DIR`.

Official installer builds add a frozen Python GUI to the copied source, dependency list, and this guide. Credentials, tokens, and virtual environments are excluded. The frozen executable is created on each target operating system during packaging; local source-only builds retain the external Python prerequisite.

Choose each destination explicitly in the publisher. The visibility dropdown applies to YouTube. Facebook targets the configured Page and does not offer the same visibility controls. If one destination succeeds and another fails, the status identifies the completed post so it is not submitted again by mistake. This integration has been validated without posting to either service; account authorization and real uploads require your own configured credentials.
