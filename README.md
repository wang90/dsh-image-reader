# dsh-image-reader

[English](README.en.md) | 中文 | [GitHub](https://github.com/wang90/dsh-image-reader)

![test](https://github.com/wang90/dsh-image-reader/actions/workflows/test.yml/badge.svg)

一个不依赖第三方 npm 包的 DSH（DeepSeek Harness）插件，让只支持文本的模型也能“看懂”图片。

它通过 DSH 的 `ctx.llm` 服务调用视觉模型，不会把图片塞给当前文本模型，也不会要求切换主模型：

- **允许当前文本模型接收图片附件**：`advertiseImage` 会让 DSH 的图片准入与 Web UI 认为当前模型支持图片，避免出现“当前模型不支持图片，请切换模型”。
- **自动识别用户附加的图片**：在 `agent/pre-step` 阶段发现用户消息里的 `ImageBlock`，用视觉模型生成文字描述，并作为插件上下文追加到同一步。主文本模型实际不会收到图片，适配器会把它投影成占位文本，因此不会报 `UNSUPPORTED_CONTENT`。
- **自动识别工具返回的图片**：`tools/post-execute` 会处理 `read_image` 等工具结果里的图片，把视觉描述追加到工具结果中。
- **提供 `describe_image` 工具**：模型可以读取本地 PNG/JPEG/WebP/GIF 文件，调用视觉模型后返回文字描述/OCR 结果。它与内置 `read_image` 不冲突；内置工具需要当前模型支持图片输入，本工具专门补足文本模型场景。

默认使用 DeepSeek 官方适配器内的视觉模型：

```text
provider: deepseek-official
model:    deepseek-v4-flash-vision-exp
```

因此通常直接复用 DSH 已经配置好的 `DEEPSEEK_API_KEY`，无需另配 OpenAI Key。

## 安装

### 方式一：作为 DSH bundle 安装（推荐）

包内已经提供 `package.json` 的 `dsh.bundle.patch` 和 `cordis.patch.yml`，可以直接被 `dsh plugin` 安装：

```sh
# 从 npm 安装
dsh plugin --profile web add dsh-image-reader

# 或从 GitHub 安装
dsh plugin --profile web add github:wang90/dsh-image-reader

# 或安装本地 checkout
dsh plugin --profile web add ./dsh-image-reader
```

安装后重启 DSH Web。

### 方式二：手动 profile patch

把下面一行加入 `$DSH_HOME/profiles/web/cordis.patch.yml`（路径按实际 clone 位置调整）：

```yaml
- insert:
    - id: image-reader
      name: '/absolute/path/to/dsh-image-reader/image-reader.mjs'
      config:
        advertiseImage: true
        describeToolImages: true
```

`patchReload: live` 的 profile 会在保存 patch 后热加载插件；普通启动则重启 DSH Web 后生效。

## 使用

### 1. 用户直接附加图片

直接在 Web UI 里附加图片并发送。主模型收到请求前，插件会：

1. 找到消息中的图片附件；
2. 调用 `deepseek-v4-flash-vision-exp` 识别；
3. 把识别结果作为一条 `plugin` 来源的上下文插入用户消息之后；
4. 主模型继续按原来的文本模型运行。

原始图片仍保存在会话历史中；以后切换到支持视觉的模型时仍然可以直接查看原图。

### 2. 模型读取本地图片

模型可以调用：

```json
{
  "file_path": "/path/to/image.png",
  "prompt": "只看左上角的报错信息，逐字转录"
}
```

返回：

```json
{
  "text": "视觉模型给出的描述/OCR 结果",
  "model": "deepseek-official/deepseek-v4-flash-vision-exp",
  "path": "...",
  "mediaType": "image/png",
  "bytes": 12345,
  "width": 800,
  "height": 600
}
```

相对路径按当前会话工作区解析，并使用 `ctx.fs`，因此仍受文件系统 sandbox 约束。

## 配置

在 patch 的插件行里可加 `config`：

```yaml
- insert:
    - id: image-reader
      name: '/absolute/path/to/dsh-image-reader/image-reader.mjs'
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
          请仔细识别并描述这张图片……
```

全部字段都有默认值；只在需要时覆盖即可。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `deepseek-official` | 调用视觉模型的 DSH provider |
| `model` | `deepseek-v4-flash-vision-exp` | 必须是声明了 `image` input modality 的模型 |
| `auto` | `true` | 是否自动识别用户附加图片 |
| `tool` | `true` | 是否注册 `describe_image` 工具 |
| `cache` | `true` | 同一附件同一提示词是否复用识别结果 |
| `skipVisionModel` | `true` | 如果当前主模型真实能力本身支持图片，则跳过自动识别，避免重复处理 |
| `advertiseImage` | `true` | 让 DSH 认为当前文本模型也接受图片，从而允许 Web UI/API 提交图片；实际图片会由本插件转成文字描述 |
| `describeToolImages` | `true` | 自动识别工具结果里的图片，例如内置 `read_image` 返回的图片会追加文字描述 |
| `maxImagesPerStep` | `8` | 单步最多自动识别几张图片 |
| `maxOutputTokens` | `2048` | 视觉模型输出 token 上限 |
| `timeoutMs` | `120000` | 单次视觉调用超时 |
| `maxDescriptionChars` | `12000` | 注入上下文的单图描述长度上限 |
| `maxToolImageBytes` | `20971520` | `describe_image` 读取的原始文件大小上限，同时受附件服务限制 |
| `reasoningEffort` | `off` | 辅助视觉调用的推理档位，`off` 可降低成本与延迟 |
| `prompt` | 内置中文识别提示词 | 视觉模型提示词 |

也支持环境变量：`DSH_IMAGE_READER_PROVIDER`、`DSH_IMAGE_READER_MODEL`、`DSH_IMAGE_READER_AUTO` 等，名称可由字段名推导。

## 失败行为

- 视觉调用失败时，自动路径不会中断当前 turn，而是把失败信息作为插件上下文注入，让主模型可以如实告诉用户。
- `describe_image` 工具失败时，按普通工具错误返回。
- 如果 `provider` / `model` 配错，错误信息会包含视觉调用的失败原因，便于在 DSH 模型设置中修正。

## 安全与数据

- 自动路径直接复用附件服务中已经持久化的图片，不会把 base64 写进会话日志。
- `describe_image` 读取文件后会调用 `ctx.attachments.saveImage` 做持久化，然后调用视觉模型。附件服务本身只接受 PNG/JPEG/WebP/GIF，并执行尺寸/字节校验。
- 文件读取通过 `ctx.fs`，遵守当前会话的文件系统策略。
