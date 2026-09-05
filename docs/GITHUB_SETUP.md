# GitHub setup

- The repository name must be exactly `mpvfx`.
- Keep `main` as the default branch.
- Enable Dependabot alerts, secret scanning, push protection, and private vulnerability reporting.
- Allow GitHub Actions to create releases with the workflow's scoped `contents: write` permission.
- Protect `main` and `v*` tags when collaborators are added.

Repository visibility is controlled only by the owner in GitHub settings. The workflows do not
change it.

The **Desktop builds** workflow validates every platform. The **Build GitHub Release** workflow
creates downloadable installers when run manually or when a matching version tag is pushed.
