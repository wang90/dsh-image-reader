# Changelog

## 0.1.0 - 2026-09-23

Initial release.

- `agent/pre-step` automatic recognition for images attached to a user prompt.
- `describe_image` tool for local PNG/JPEG/WebP/GIF files.
- `advertiseImage` capability bridge so DSH accepts images while a text-only model is selected.
- `tools/post-execute` image recognition for image-bearing tool results.
- Configurable provider, model, prompt, timeout, image limits, caching, and tool toggles.
- Unit tests with `node --test`.
