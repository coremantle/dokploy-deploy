import { describe, effect, expect, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Option, PlatformError } from 'effect'

import { ActionInputs } from '#action-inputs.config.ts'
import {
  WorkflowCommands,
  WorkflowOutputError,
  escapeCommandData,
  outputLines,
} from '#workflow-commands.ts'

interface WrittenFile {
  readonly path: string
  readonly data: string
  readonly flag: string | undefined
}

function commandsWriting({
  outputFile,
  fail = false,
}: {
  readonly outputFile: Option.Option<string>
  readonly fail?: boolean
}) {
  const written: Array<WrittenFile> = []
  const layer = WorkflowCommands.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionInputs.buildTestLayer({ outputFile }),
        FileSystem.layerNoop({
          writeFileString: (...[path, data, options]) =>
            fail
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: 'PermissionDenied',
                    module: 'FileSystem',
                    method: 'writeFileString',
                    description: 'permission denied',
                    pathOrDescriptor: path,
                  }),
                )
              : Effect.sync(() => {
                  written.push({ path, data, flag: options?.flag })
                }),
        }),
      ),
    ),
  )
  return { written, layer }
}

describe('escapeCommandData', () => {
  it('should escape what the runner would read as the end of the command', () => {
    // Given: a value holding a percent sign and line breaks
    const value = 'a%b\r\nc'

    // When: escaping it for a workflow command
    const escaped = escapeCommandData(value)

    // Then: the runner reads it back as one value on one line
    expect(escaped).toBe('a%25b%0D%0Ac')
  })
})

describe('outputLines', () => {
  it('should write one name=value line per output, each on one line', () => {
    // Given: outputs, one of them with a stray line break
    const outputs = { status: 'done', sha: '', note: 'a\nb' }

    // When: rendering them for the output file
    const lines = outputLines(outputs)

    // Then: the runner reads three outputs
    expect(lines).toBe('status=done\nsha=\nnote=a b\n')
  })
})

describe('WorkflowCommands.setOutputs', () => {
  effect('should append the outputs to the runner output file', () =>
    Effect.gen(function* () {
      // Given: a runner giving an output file
      const { written, layer } = commandsWriting({
        outputFile: Option.some('/runner/output'),
      })

      // When: setting outputs
      yield* WorkflowCommands.pipe(
        Effect.flatMap((commands) =>
          commands.setOutputs({ 'deployment-id': 'deployment-1' }),
        ),
        Effect.provide(layer),
      )

      // Then: they are appended, never overwriting what earlier steps wrote
      expect(written).toEqual([
        {
          path: '/runner/output',
          data: 'deployment-id=deployment-1\n',
          flag: 'a',
        },
      ])
    }),
  )

  effect('should only log the outputs without an output file', () =>
    Effect.gen(function* () {
      // Given: a local run
      const { written, layer } = commandsWriting({ outputFile: Option.none() })

      // When: setting outputs
      yield* WorkflowCommands.pipe(
        Effect.flatMap((commands) => commands.setOutputs({ status: 'done' })),
        Effect.provide(layer),
      )

      // Then: no file is written
      expect(written).toEqual([])
    }),
  )

  effect('should fail when the output file cannot be written', () =>
    Effect.gen(function* () {
      // Given: an output file the step cannot write
      const { layer } = commandsWriting({
        outputFile: Option.some('/runner/output'),
        fail: true,
      })

      // When: setting outputs
      const error = yield* WorkflowCommands.pipe(
        Effect.flatMap((commands) => commands.setOutputs({ status: 'done' })),
        Effect.provide(layer),
        Effect.flip,
      )

      // Then: the step fails, naming the file
      expect(error).toBeInstanceOf(WorkflowOutputError)
      expect(error.message).toContain('/runner/output')
    }),
  )
})
