# Remote asset provenance

MpVFX source does not contain the remote assets below. The application retrieves them only when a
user invokes the related feature. A URL in source is not permission to mirror or bundle its target.

## Background-removal model

- Application model ID: `u2net_human_seg`
- Download URL:
  `https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx`
- Pinned SHA-256:
  `01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c`
- Declared lineage: the rembg model catalog identifies this as a converted U²-Net human
  segmentation model and links to `https://github.com/xuebinqin/U-2-Net`.
- Upstream source license: the U²-Net source repository declares Apache-2.0; rembg source declares
  MIT.

The release asset does not currently carry a model-specific license, immutable conversion record,
or separate provenance statement. Those source-code licenses should not be assumed to settle every
right in the converted weight file or its training data. MpVFX therefore downloads the exact
checksum-pinned asset into a user cache but does not commit or package it.

Before distributing the model with MpVFX, obtain written clarification covering the exact ONNX
asset and its training-data restrictions, or replace it with a model whose weight and dataset rights
are explicit. Record the replacement URL, immutable version, checksum, license, attribution,
conversion history, and commercial/redistribution terms.

## Online fonts and user URLs

When a user selects an online font, MpVFX requests the selected family from Google Fonts. Font
licenses vary by family; MpVFX does not mirror those files in this repository. Any future offline
font bundle must retain the license for each exact font file.

User-supplied remote media remains governed by its source. Maintainers and users must not treat the
ability to load a URL as evidence that its media can be copied, edited, or redistributed.
