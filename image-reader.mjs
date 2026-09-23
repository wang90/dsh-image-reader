/**
 * dsh-image-reader: give text-only Harness models access to images through the
 * DeepSeek vision route.
 *
 * The plugin has two user-visible jobs:
 *
 * 1. `agent/pre-step`: any image attached to the current prompt is sent to a
 *    configurable vision model first, and the text result is appended as
 *    plugin-sourced context. The durable session still keeps the original
 *    image, so a later vision-capable model can inspect it directly.
 * 2. `describe_image`: a text-only, model-callable tool that reads a local
 *    image through `ctx.fs`, asks the vision model to recognize it, and returns
 *    the answer as ordinary text. This complements the built-in `read_image`
 *    tool, which deliberately refuses when the active model has no image input.
 *
 * All runtime dependencies are Node built-ins and the host Cordis services, so
 * the module can be loaded directly from a profile patch without installing a
 * package.
 */

import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'image-reader'

/** Services supplied by the standard dsh/base composition. */
export const inject = ['llm', 'tools', 'attachments', 'fs']

const TOOL_NAME = 'describe_image'

const DEFAULT_PROVIDER = 'deepseek-official'
const DEFAULT_MODEL = 'deepseek-v4-flash-vision-exp'
const DEFAULT_PROMPT = [
  '请仔细识别并描述这张图片。用中文输出，尽量准确：',
  '1. 图片类型与整体内容（照片、截图、界面、文档、图表、代码等）。',
  '2. 图中所有可见文字，逐字转录；代码、命令、报错、数字保持原始格式。',
  '3. 关键对象、人物、控件、图表、数据及其关系。',
  '4. 如果图片与软件、终端、网页或错误信息有关，说明界面结构、关键状态和可能的异常。',
  '只描述图片中可见的内容；不确定的地方明确写“不确定”，不要编造。',
].join('\n')

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_IMAGES_PER_STEP = 8
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048
const DEFAULT_REASONING_EFFORT = 'off'
const DEFAULT_MAX_DESCRIPTION_CHARS = 12_000
const DEFAULT_MAX_TOOL_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_CACHE_ENTRIES = 256

const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

function envString(envName) {
  const value = process.env[envName]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readOptionalString(raw, key, envName, fallback) {
  const fromConfig = raw[key]
  if (fromConfig !== undefined) {
    if (typeof fromConfig !== 'string' || fromConfig.trim().length === 0) {
      throw new Error(`image-reader: ${key} must be a non-empty string`)
    }
    return fromConfig.trim()
  }
  return envString(envName) ?? fallback
}

function readOptionalBoolean(raw, key, envName, fallback) {
  const fromConfig = raw[key]
  if (fromConfig !== undefined) {
    if (typeof fromConfig !== 'boolean') throw new Error(`image-reader: ${key} must be a boolean`)
    return fromConfig
  }
  const env = envString(envName)
  if (env === undefined) return fallback
  if (env === 'true' || env === '1') return true
  if (env === 'false' || env === '0') return false
  throw new Error(`image-reader: ${envName} must be true/false or 1/0`)
}

function readOptionalPositiveInteger(raw, key, envName, fallback) {
  const fromConfig = raw[key]
  if (fromConfig !== undefined) {
    if (!Number.isSafeInteger(fromConfig) || fromConfig <= 0) {
      throw new Error(`image-reader: ${key} must be a positive integer`)
    }
    return fromConfig
  }
  const env = envString(envName)
  if (env === undefined) return fallback
  const parsed = Number(env)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`image-reader: ${envName} must be a positive integer`)
  }
  return parsed
}

/** Validate and normalize user configuration without importing a schema package. */
export function normalizeConfig(rawConfig) {
  const raw = rawConfig ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('image-reader: config must be an object')
  }
  return Object.freeze({
    provider: readOptionalString(raw, 'provider', 'DSH_IMAGE_READER_PROVIDER', DEFAULT_PROVIDER),
    model: readOptionalString(raw, 'model', 'DSH_IMAGE_READER_MODEL', DEFAULT_MODEL),
    prompt: readOptionalString(raw, 'prompt', 'DSH_IMAGE_READER_PROMPT', DEFAULT_PROMPT),
    timeoutMs: readOptionalPositiveInteger(raw, 'timeoutMs', 'DSH_IMAGE_READER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    maxImagesPerStep: readOptionalPositiveInteger(
      raw,
      'maxImagesPerStep',
      'DSH_IMAGE_READER_MAX_IMAGES',
      DEFAULT_MAX_IMAGES_PER_STEP,
    ),
    maxOutputTokens: readOptionalPositiveInteger(
      raw,
      'maxOutputTokens',
      'DSH_IMAGE_READER_MAX_OUTPUT_TOKENS',
      DEFAULT_MAX_OUTPUT_TOKENS,
    ),
    maxDescriptionChars: readOptionalPositiveInteger(
      raw,
      'maxDescriptionChars',
      'DSH_IMAGE_READER_MAX_DESCRIPTION_CHARS',
      DEFAULT_MAX_DESCRIPTION_CHARS,
    ),
    maxToolImageBytes: readOptionalPositiveInteger(
      raw,
      'maxToolImageBytes',
      'DSH_IMAGE_READER_MAX_TOOL_IMAGE_BYTES',
      DEFAULT_MAX_TOOL_IMAGE_BYTES,
    ),
    reasoningEffort: readOptionalString(
      raw,
      'reasoningEffort',
      'DSH_IMAGE_READER_REASONING_EFFORT',
      DEFAULT_REASONING_EFFORT,
    ),
    auto: readOptionalBoolean(raw, 'auto', 'DSH_IMAGE_READER_AUTO', true),
    tool: readOptionalBoolean(raw, 'tool', 'DSH_IMAGE_READER_TOOL', true),
    cache: readOptionalBoolean(raw, 'cache', 'DSH_IMAGE_READER_CACHE', true),
    skipVisionModel: readOptionalBoolean(
      raw,
      'skipVisionModel',
      'DSH_IMAGE_READER_SKIP_VISION_MODEL',
      true,
    ),
    advertiseImage: readOptionalBoolean(
      raw,
      'advertiseImage',
      'DSH_IMAGE_READER_ADVERTISE_IMAGE',
      true,
    ),
    describeToolImages: readOptionalBoolean(
      raw,
      'describeToolImages',
      'DSH_IMAGE_READER_DESCRIBE_TOOL_IMAGES',
      true,
    ),
  })
}

function errorMessage(error) {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
    return JSON.stringify(error)
  } catch {
    return '<unprintable error>'
  }
}

function truncate(value, maxChars) {
  const text = String(value)
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
  return value
}

function createPluginMessage(content, pluginName = name) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'plugin', plugin: pluginName },
  })
}

function matchesBytes(data, offset, expected) {
  if (data.byteLength < offset + expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (data[offset + index] !== expected[index]) return false
  }
  return true
}

function matchesAscii(data, offset, value) {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/** Detect one of the image formats accepted by the durable attachment store. */
export function sniffImageMediaType(data) {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

function collectImageOccurrencesFromContent(content) {
  const seen = new Set()
  const occurrences = []
  const walk = (blocks) => {
    for (const block of blocks) {
      if (block.type === 'image') {
        const id = String(block.attachment.attachmentId)
        if (!seen.has(id)) {
          seen.add(id)
          occurrences.push({ ref: block.attachment })
        }
      } else if (block.type === 'tool-result') {
        walk(block.content)
      }
    }
  }
  walk(content)
  return occurrences
}

function collectImageOccurrences(messages) {
  const occurrences = []
  const seen = new Set()
  for (const message of messages) {
    for (const occurrence of collectImageOccurrencesFromContent(message.content)) {
      const id = String(occurrence.ref.attachmentId)
      if (seen.has(id)) continue
      seen.add(id)
      occurrences.push(occurrence)
    }
  }
  return occurrences
}

function messageContainsImage(message) {
  return collectImageOccurrencesFromContent(message.content).length > 0
}

function formatImageRef(ref) {
  const namePart = ref.name === undefined ? '' : `名称=${JSON.stringify(ref.name)}, `
  const id = String(ref.attachmentId)
  const shortId = id.length <= 23 ? id : `${id.slice(0, 23)}…`
  return `${namePart}${ref.width}x${ref.height}px, ${ref.mediaType}, ${ref.bytes} bytes, 附件=${shortId}`
}

function indent(text) {
  return String(text)
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')
}

function formatRecognitionText(config, results, skipped, lead) {
  const lines = [
    lead ?? `[${name}] 已自动调用视觉模型 ${config.provider}/${config.model} 识别当前请求中的图片。`
      + '下面内容是对图片的客观识别结果，请把它当作图片本身的内容来理解；回答时不要编造未识别出的细节。',
  ]
  results.forEach((result, index) => {
    if (result.error !== undefined) {
      lines.push(`图片 ${index + 1}（${formatImageRef(result.ref)}）识别失败：${truncate(result.error, 800)}`)
      return
    }
    lines.push(`图片 ${index + 1}（${formatImageRef(result.ref)}）识别结果：`)
    lines.push(indent(truncate(result.text, config.maxDescriptionChars)))
  })
  if (skipped > 0) {
    lines.push(`另有 ${skipped} 张图片超过 maxImagesPerStep=${config.maxImagesPerStep} 限制，未自动识别。`)
  }
  return lines.join('\n')
}

function combinedSignal(signals, timeoutMs) {
  const active = signals.filter(signal => signal !== undefined && signal !== null)
  return AbortSignal.any([
    ...active,
    ...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)]),
  ])
}

async function routeInfo(agent) {
  const routed = typeof agent?.session?.requestHeader === 'function'
    ? agent.session.requestHeader()?.config
    : undefined
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    return undefined
  }
  return { provider, model }
}

async function mainModelSeesImages(resolveModelInfo, config, agent, signal) {
  if (!config.skipVisionModel) return false
  const route = await routeInfo(agent)
  if (route === undefined) return false
  try {
    const info = await resolveModelInfo(route.provider, route.model, signal)
    return Array.isArray(info.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

async function toolResultNeedsDescription(resolveModelInfo, exec, signal) {
  const route = await routeInfo(exec.agent)
  if (route === undefined) return true
  try {
    const info = await resolveModelInfo(route.provider, route.model, signal)
    return !(Array.isArray(info.inputModalities) && info.inputModalities.includes('image'))
  } catch {
    return true
  }
}

function advertiseImageCapability(info) {
  if (info === null || typeof info !== 'object') return info
  const modalities = info.inputModalities
  if (!Array.isArray(modalities) || modalities.includes('image')) return info
  return { ...info, inputModalities: [...modalities, 'image'] }
}

function installImageCapabilityAdvertiser(llm, config, originalResolveModelInfo) {
  if (!config.advertiseImage) return () => {}
  const hadOwn = Object.hasOwn(llm, 'resolveModelInfo')
  const ownDescriptor = Object.getOwnPropertyDescriptor(llm, 'resolveModelInfo')
  const wrapped = async (provider, model, signal) => advertiseImageCapability(
    await originalResolveModelInfo(provider, model, signal),
  )
  try {
    llm.resolveModelInfo = wrapped
  } catch {
    return () => {}
  }
  return () => {
    try {
      if (hadOwn) Object.defineProperty(llm, 'resolveModelInfo', ownDescriptor)
      else delete llm.resolveModelInfo
    } catch {
      // Best-effort restoration during HMR/disposal.
    }
  }
}

async function collectVisionText(ctx, config, ref, prompt, signal) {
  signal.throwIfAborted()
  const message = createPluginMessage([
    { type: 'text', text: prompt },
    { type: 'image', attachment: ref },
  ])
  const options = {
    provider: config.provider,
    model: config.model,
    messages: [message],
    maxTokens: config.maxOutputTokens,
    ...(config.reasoningEffort.length === 0 ? {} : { reasoningEffort: config.reasoningEffort }),
    signal,
  }

  const deltas = new Map()
  const finals = new Map()
  const order = []
  let finish

  for await (const chunk of ctx.llm.stream(options)) {
    switch (chunk.type) {
      case 'text-delta': {
        if (finals.has(chunk.index)) break
        if (!deltas.has(chunk.index)) {
          deltas.set(chunk.index, '')
          order.push(chunk.index)
        }
        deltas.set(chunk.index, deltas.get(chunk.index) + chunk.text)
        break
      }
      case 'block-end': {
        if (chunk.block?.type !== 'text') break
        if (!finals.has(chunk.index) && !deltas.has(chunk.index)) order.push(chunk.index)
        finals.set(chunk.index, chunk.block.text)
        break
      }
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }

  if (finish?.kind === 'error') {
    throw new Error(`视觉模型调用失败：${truncate(errorMessage(finish.failure), 400)}`)
  }
  if (finish?.kind === 'aborted') {
    throw new Error(`视觉模型调用已取消：${truncate(errorMessage(finish.failure), 400)}`)
  }
  if (finish?.kind === 'max-tokens') {
    throw new Error('视觉模型输出被 max-tokens 截断，未得到完整描述')
  }

  const text = order
    .map(index => finals.has(index) ? finals.get(index) : deltas.get(index) ?? '')
    .join('\n\n')
    .trim()
  if (text.length === 0) throw new Error('视觉模型没有返回文本描述')
  return text
}

async function recognizeAttachment(ctx, config, ref, prompt, signal) {
  return collectVisionText(ctx, config, ref, prompt, signal)
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

function recognizeCached(ctx, config, ref, prompt, signal, cache) {
  const key = `${String(ref.attachmentId)}\u0000${prompt}`
  if (config.cache) {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
  }

  const task = recognizeAttachment(ctx, config, ref, prompt, signal)
  if (!config.cache) return task
  const cached = task.catch((error) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, cached)
  trimCache(cache, DEFAULT_CACHE_ENTRIES)
  return cached
}

async function handlePreStep(ctx, config, cache, lifetimeSignal, originalResolveModelInfo, payload, next) {
  const decision = await next()
  if (!config.auto || decision.kind === 'reject' || payload.signal.aborted) return decision

  const occurrences = collectImageOccurrences(decision.messages)
  if (occurrences.length === 0) return decision

  const signal = combinedSignal([payload.signal, lifetimeSignal], config.timeoutMs)
  try {
    if (await mainModelSeesImages(originalResolveModelInfo, config, payload.agent, signal)) return decision

    const selected = occurrences.slice(0, config.maxImagesPerStep)
    const results = []
    for (const occurrence of selected) {
      if (payload.signal.aborted || lifetimeSignal.aborted) break
      try {
        const text = await recognizeCached(ctx, config, occurrence.ref, config.prompt, signal, cache)
        results.push({ ref: occurrence.ref, text })
      } catch (error) {
        if (payload.signal.aborted || lifetimeSignal.aborted) break
        results.push({ ref: occurrence.ref, error: errorMessage(error) })
      }
    }
    if (results.length === 0) return decision

    const text = formatRecognitionText(config, results, occurrences.length - selected.length)
    const message = createPluginMessage([{ type: 'text', text }])
    const lastImageIndex = decision.messages.findLastIndex(messageContainsImage)
    const messages = [...decision.messages]
    messages.splice(lastImageIndex >= 0 ? lastImageIndex + 1 : messages.length, 0, message)
    return { ...decision, messages }
  } catch (error) {
    ctx.logger?.warn?.(`image-reader: automatic recognition failed: ${errorMessage(error)}`)
    return decision
  }
}

async function handlePostExecute(
  ctx,
  config,
  cache,
  lifetimeSignal,
  originalResolveModelInfo,
  exec,
  result,
  next,
) {
  const decision = await next()
  if (!config.describeToolImages || decision.kind !== 'accept') return decision

  const content = Array.isArray(decision.content) ? decision.content : result.content
  const occurrences = collectImageOccurrencesFromContent(content)
  if (occurrences.length === 0) return decision

  const signal = combinedSignal([exec.signal, lifetimeSignal], config.timeoutMs)
  try {
    if (!(await toolResultNeedsDescription(originalResolveModelInfo, exec, signal))) return decision

    const selected = occurrences.slice(0, config.maxImagesPerStep)
    const results = []
    for (const occurrence of selected) {
      if (exec.signal.aborted || lifetimeSignal.aborted) break
      try {
        const text = await recognizeCached(ctx, config, occurrence.ref, config.prompt, signal, cache)
        results.push({ ref: occurrence.ref, text })
      } catch (error) {
        if (exec.signal.aborted || lifetimeSignal.aborted) break
        results.push({ ref: occurrence.ref, error: errorMessage(error) })
      }
    }
    if (results.length === 0) return decision

    const text = formatRecognitionText(
      config,
      results,
      occurrences.length - selected.length,
      `[${name}] 工具返回的图片已由视觉模型 ${config.provider}/${config.model} 识别。`
        + '下面内容可以视为该工具结果中的图片内容；回答时不要编造未识别出的细节。',
    )
    return {
      ...decision,
      content: [...content, { type: 'text', text }],
    }
  } catch (error) {
    ctx.logger?.warn?.(`image-reader: tool-result recognition failed: ${errorMessage(error)}`)
    return decision
  }
}

function createDescribeImageTool(ctx, config, cache, lifetimeSignal) {
  return {
    name: TOOL_NAME,
    description: 'Recognize a local PNG/JPEG/WebP/GIF image with a separate vision model and return a text description or OCR result. '
      + 'Use this when the current model cannot inspect image input itself, or when the user asks what is inside a local image file. '
      + 'Unlike the built-in read_image tool, this tool returns text, so it works with text-only models. '
      + 'The answer is generated by the configured vision route and is appended to the conversation as a normal tool result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to a local PNG/JPEG/WebP/GIF file. Relative paths use the session workspace as their base.',
        },
        prompt: {
          type: 'string',
          description: 'Optional extra question or instruction for the vision model. Omit to use the plugin default prompt.',
        },
      },
      required: ['file_path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
          path: { type: 'string' },
          mediaType: { type: 'string', enum: [...IMAGE_MEDIA_TYPES] },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['text', 'model', 'path', 'mediaType', 'bytes', 'width', 'height'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('describe_image: arguments must be an object')
      }
      const filePath = args.file_path
      const customPrompt = args.prompt
      if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('describe_image: file_path must be a non-empty string')
      }
      if (customPrompt !== undefined && (typeof customPrompt !== 'string' || customPrompt.trim().length === 0)) {
        throw new Error('describe_image: prompt must be a non-empty string when provided')
      }

      const fs = ctx.fs
      const attachments = ctx.attachments
      const cwd = exec.agent?.session?.header?.cwd
      const target = await fs.resolve(filePath, {
        ...(cwd === undefined ? {} : { cwd }),
        signal: exec.signal,
      })
      const info = await fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`describe_image: file not found: ${target.displayPath}`)
      if (info.type !== 'file') throw new Error(`describe_image: not a regular file: ${target.displayPath}`)

      const byteCap = Math.min(
        config.maxToolImageBytes,
        attachments.imageLimits.maxImageBytes,
        attachments.imageLimits.maxMessageImageBytes,
      )
      const data = await fs.readBytes(target, exec.signal, byteCap)
      const mediaType = sniffImageMediaType(data)
      if (mediaType === undefined) {
        throw new Error(`describe_image: not a supported image file (expected PNG/JPEG/WebP/GIF): ${target.displayPath}`)
      }

      const ref = await attachments.saveImage({
        data,
        mediaType,
        name: basename(target.displayPath),
      })
      const signal = combinedSignal([exec.signal, lifetimeSignal], config.timeoutMs)
      const prompt = customPrompt === undefined ? config.prompt : `${config.prompt}\n\n用户额外要求：${customPrompt}`
      const text = await recognizeCached(ctx, config, ref, prompt, signal, cache)

      return {
        text,
        model: `${config.provider}/${config.model}`,
        path: target.displayPath,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
      }
    },
  }
}

/**
 * Install automatic recognition and the `describe_image` tool.
 * @param ctx - owning Harness context.
 * @param rawConfig - optional `config:` object from the profile patch.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const lifetime = new AbortController()
  const cache = new Map()
  const originalResolveModelInfo = ctx.llm.resolveModelInfo.bind(ctx.llm)
  const restoreImageCapabilityAdvertiser = installImageCapabilityAdvertiser(
    ctx.llm,
    config,
    originalResolveModelInfo,
  )

  ctx.effect(() => () => {
    restoreImageCapabilityAdvertiser()
    lifetime.abort(new Error('image-reader: plugin disposed'))
    cache.clear()
  }, 'image-reader lifetime')

  ctx.on(
    'agent/pre-step',
    (payload, next) => handlePreStep(
      ctx,
      config,
      cache,
      lifetime.signal,
      originalResolveModelInfo,
      payload,
      next,
    ),
    { prepend: true },
  )

  ctx.on(
    'tools/post-execute',
    (exec, result, next) => handlePostExecute(
      ctx,
      config,
      cache,
      lifetime.signal,
      originalResolveModelInfo,
      exec,
      result,
      next,
    ),
    { prepend: true },
  )

  if (config.tool) {
    ctx.tools.register(createDescribeImageTool(ctx, config, cache, lifetime.signal))
  }
}
