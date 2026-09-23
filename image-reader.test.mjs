import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, normalizeConfig, sniffImageMediaType } from './image-reader.mjs'

const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)
const REF = {
  attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mediaType: 'image/png',
  bytes: PNG_BYTES.length,
  width: 1,
  height: 1,
  name: 'pixel.png',
}

function createHarness() {
  const listeners = new Map()
  const tools = new Map()
  const effects = []
  const streamCalls = []
  const saved = []
  const ctx = {
    logger: { warn() {}, debug() {} },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(setup) {
      effects.push(setup())
      return () => {}
    },
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, name: model, inputModalities: ['text'] }
      },
      async *stream(options) {
        streamCalls.push(options)
        yield { type: 'text-delta', index: 0, text: '图中是一张测试图片。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    attachments: {
      imageLimits: Object.freeze({
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      }),
      async saveImage(input) {
        saved.push(input)
        return { ...REF, mediaType: input.mediaType, bytes: input.data.length, name: input.name }
      },
    },
    fs: {
      async resolve(filePath) {
        return { displayPath: filePath }
      },
      async stat() {
        return { type: 'file', size: PNG_BYTES.length }
      },
      async readBytes() {
        return PNG_BYTES
      },
    },
  }
  return { ctx, listeners, tools, streamCalls, saved }
}

test('normalizes configuration and detects image formats', () => {
  const config = normalizeConfig({ maxImagesPerStep: 3, tool: false })
  assert.equal(config.provider, 'deepseek-official')
  assert.equal(config.model, 'deepseek-v4-flash-vision-exp')
  assert.equal(config.maxImagesPerStep, 3)
  assert.equal(config.tool, false)
  assert.equal(sniffImageMediaType(PNG_BYTES), 'image/png')
  assert.throws(() => normalizeConfig({ maxImagesPerStep: 0 }), /positive integer/)
})

test('auto-recognizes attached images and appends plugin context', async () => {
  const { ctx, listeners, streamCalls } = createHarness()
  apply(ctx, { timeoutMs: 5_000 })

  const preStep = listeners.get('agent/pre-step')
  assert.equal(typeof preStep, 'function')

  const decision = await preStep({
    agent: { options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, session: {} },
    signal: new AbortController().signal,
    turn: 1,
    step: 1,
  }, async () => ({
    kind: 'enter',
    messages: [{
      id: 'm1',
      role: 'user',
      content: [{ type: 'image', attachment: REF }],
      source: { kind: 'user' },
    }],
  }))

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.kind, 'plugin')
  assert.match(decision.messages[1].content[0].text, /图中是一张测试图片/)
  assert.equal(streamCalls.length, 1)
  assert.equal(streamCalls[0].provider, 'deepseek-official')
  assert.equal(streamCalls[0].messages[0].content[1].type, 'image')
})

test('advertises image capability for text-only routes without changing the real resolver', async () => {
  const { ctx } = createHarness()
  const before = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash')
  assert.deepEqual(before.inputModalities, ['text'])

  apply(ctx, {})

  const after = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash')
  assert.deepEqual(after.inputModalities, ['text', 'image'])
})

test('describes images returned by tools', async () => {
  const { ctx, listeners, streamCalls } = createHarness()
  apply(ctx, { timeoutMs: 5_000 })

  const postExecute = listeners.get('tools/post-execute')
  assert.equal(typeof postExecute, 'function')

  const result = {
    content: [{
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [{ type: 'image', attachment: REF }],
    }],
    isError: false,
  }
  const decision = await postExecute(
    { signal: new AbortController().signal },
    result,
    async () => ({ kind: 'accept' }),
  )

  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 2)
  assert.match(decision.content[1].text, /工具返回的图片/)
  assert.equal(streamCalls.length, 1)
})

test('describe_image reads a local file and returns text', async () => {
  const { ctx, tools, saved, streamCalls } = createHarness()
  apply(ctx, { timeoutMs: 5_000 })

  const tool = tools.get('describe_image')
  assert.ok(tool)
  assert.equal(typeof tool.execute, 'function')

  const result = await tool.execute(
    { file_path: '/tmp/pixel.png' },
    { signal: new AbortController().signal },
  )

  assert.equal(result.text, '图中是一张测试图片。')
  assert.equal(result.mediaType, 'image/png')
  assert.equal(result.width, 1)
  assert.equal(result.height, 1)
  assert.equal(saved.length, 1)
  assert.equal(streamCalls.length, 1)
  assert.equal(tool.output.render(null, result)[0].text, '图中是一张测试图片。')
})
