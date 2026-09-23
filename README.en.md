# dsh-image-reader

[中文](README.md) | English | [GitHub](https://github.com/wang90/dsh-image-reader)

![test](https://github.com/wang90/dsh-image-reader/actions/workflows/test.yml/badge.svg)

A zero-dependency [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) plugin that lets text-only models understand images through a separate vision model.

It keeps the selected text model selected and bridges images instead of sending raw image input to it:

- **Image admission bridge**: when a text-only model is selected, the plugin advertises `image` input capability to DSH's image admission and Web UI. Attachments are accepted instead of showing “the current model does not support images”.
- **Automatic prompt recognition**: during `agent/pre-step`, images attached to the user prompt are sent to a vision model; the text result is injected as plugin-sourced context.
- **Tool-result recognition**: during `tools/post-execute`, images returned by tools such as the built-in `read_image` get a text description appended to the tool result.
- **`describe_image` tool**: a text-only model can ask the vision model to inspect a local PNG/JPEG/WebP/GIF file and return text/OCR.

The default vision route is DeepSeek's own multimodal adapter model, so it normally reuses the DSH `DEEPSEEK_API_KEY` and needs no separate OpenAI key:

```text
provider: deepseek-official
model:    deepseek-v4-flash-vision-exp
```

## Install as a DSH bundle

This package declares `dsh.bundle.patch`, so `dsh plugin` can install it into a profile.

From npm:

```sh
dsh plugin --profile web add dsh-image-reader
```

From GitHub:

```sh
dsh plugin --profile web add github:wang90/dsh-image-reader
```

Then restart DSH Web. `dsh plugin` records the package in the profile's `dsh.profile.bundles`; the bundle layer in `cordis.patch.yml` is applied on the next start.

If you are checking out this repository locally:

```sh
dsh plugin --profile web add ./dsh-image-reader
```

## Install with a manual profile patch

Add this to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: image-reader
      name: '/absolute/path/to/dsh-image-reader/image-reader.mjs'
      config:
        advertiseImage: true
        describeToolImages: true
```

A `patchReload: live` profile hot-reloads the patch and plugin. For other profiles, restart DSH.

## Usage

### Attached images

Attach an image in the Web UI and send it. The plugin recognizes it with the configured vision model, injects the description, and the selected text model answers from that description. The original image remains in the durable session history.

### Local files through `describe_image`

The model can call:

```json
{
  "file_path": "/path/to/image.png",
  "prompt": "Transcribe only the error message in the screenshot."
}
```

It returns a canonical object containing `text`, `model`, `path`, `mediaType`, `bytes`, `width`, and `height`.

## Configuration

Configuration can be supplied in the bundle row or in a user patch:

```yaml
- insert:
    - id: image-reader
      name: 'dsh-image-reader'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash-vision-exp
        auto: true
        tool: true
        cache: true
        skipVisionModel: true
        advertiseImage: true
        describeToolImages: true
        maxImagesPerStep: 8
        maxOutputTokens: 2048
        timeoutMs: 120000
        maxDescriptionChars: 12000
        maxToolImageBytes: 20971520
        reasoningEffort: 'off'
        prompt: |
          Describe the image carefully...
```

| Field | Default | Description |
| --- | --- | --- |
| `provider` | `deepseek-official` | DSH provider used for the vision call. |
| `model` | `deepseek-v4-flash-vision-exp` | Must declare `image` input capability in its adapter. |
| `auto` | `true` | Recognize images attached to user prompts. |
| `tool` | `true` | Register the `describe_image` tool. |
| `cache` | `true` | Reuse recognition results for the same attachment and prompt. |
| `skipVisionModel` | `true` | Skip extra recognition when the selected model's real route already accepts images. |
| `advertiseImage` | `true` | Allow DSH admission/UI to accept images while a text-only model is selected. |
| `describeToolImages` | `true` | Describe images inside tool results. |
| `maxImagesPerStep` | `8` | Maximum images auto-recognized per step. |
| `maxOutputTokens` | `2048` | Vision model output token cap. |
| `timeoutMs` | `120000` | Per-vision-call timeout. |
| `maxDescriptionChars` | `12000` | Per-image description bound injected into context. |
| `maxToolImageBytes` | `20971520` | Raw file size cap for `describe_image`; also bounded by the attachment service. |
| `reasoningEffort` | `off` | Reasoning effort for the auxiliary vision call. |
| `prompt` | Built-in prompt | Vision model instruction. |

Environment variable equivalents are available, for example `DSH_IMAGE_READER_PROVIDER`, `DSH_IMAGE_READER_MODEL`, `DSH_IMAGE_READER_AUTO`, and so on.

## Development

```sh
node --check image-reader.mjs
node --test image-reader.test.mjs
```

There is no build step; the plugin runs directly from `image-reader.mjs`.

## Security notes

- Attached images are read through DSH's durable attachment service.
- `describe_image` reads through `ctx.fs`, so it respects the current filesystem policy.
- The plugin does not put base64 image data into the session log.
- The vision call uses DSH provider credentials; no extra key handling is built in.

## License

MIT
