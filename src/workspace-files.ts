import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Predicate,
  Schema,
  pipe,
} from 'effect'
import * as Yaml from 'effect/encoding/Yaml'

import { EffectService } from '#effect/index.ts'
import { ComposeDocument, composeFileFrom } from '#compose/compose-file.ts'
import type { ComposeFile } from '#compose/compose-file.ts'
import { Manifest, manifestParseOptions } from '#manifest/manifest.ts'

export const WorkspaceFileKind = Schema.Literals(['manifest', 'compose file'])

export type WorkspaceFileKind = typeof WorkspaceFileKind.Type

export class WorkspaceFileError extends Schema.TaggedError<WorkspaceFileError>()(
  'WorkspaceFileError',
  {
    kind: WorkspaceFileKind,
    path: Schema.String,
    message: Schema.String,
  },
) {
  static invalid({
    kind,
    path,
    reason,
  }: WorkspaceFile & { readonly reason: string }): WorkspaceFileError {
    return new WorkspaceFileError({
      kind,
      path,
      message: `${kind} ${path}: ${reason}`,
    })
  }
}

interface WorkspaceFile {
  readonly kind: WorkspaceFileKind
  readonly path: string
}

export interface WorkspaceFilesShape {
  readonly readManifest: (
    path: string,
  ) => Effect.Effect<Manifest, WorkspaceFileError>
  readonly readCompose: (
    path: string,
  ) => Effect.Effect<ComposeFile, WorkspaceFileError>
}

function reasonOf(cause: unknown) {
  return Predicate.isError(cause) ? cause.message : String(cause)
}

function decodeManifest({
  file,
  document,
}: {
  readonly file: WorkspaceFile
  readonly document: unknown
}) {
  return pipe(
    Schema.decodeUnknownEffect(Manifest)(document, manifestParseOptions),
    Effect.mapError((cause) =>
      WorkspaceFileError.invalid({ ...file, reason: reasonOf(cause) }),
    ),
    Effect.withSpan('WorkspaceFiles.decodeManifest', {
      attributes: { path: file.path },
    }),
  )
}

function decodeCompose({
  file,
  document,
}: {
  readonly file: WorkspaceFile
  readonly document: unknown
}) {
  return pipe(
    Schema.decodeUnknownEffect(ComposeDocument)(document),
    Effect.mapError((cause) =>
      WorkspaceFileError.invalid({ ...file, reason: reasonOf(cause) }),
    ),
    Effect.map((decoded) => composeFileFrom({ document, decoded })),
    Effect.withSpan('WorkspaceFiles.decodeCompose', {
      attributes: { path: file.path },
    }),
  )
}

class FileSystemWorkspaceFiles implements WorkspaceFilesShape {
  private readonly fileSystem: FileSystem.FileSystem

  private constructor(fileSystem: FileSystem.FileSystem) {
    this.fileSystem = fileSystem
  }

  static make(fileSystem: FileSystem.FileSystem): FileSystemWorkspaceFiles {
    return new FileSystemWorkspaceFiles(fileSystem)
  }

  readManifest(path: string) {
    const file = { path, kind: 'manifest' } as const
    return pipe(
      this.readYaml(file),
      Effect.flatMap((document) => decodeManifest({ file, document })),
      Effect.withSpan('WorkspaceFiles.readManifest', { attributes: { path } }),
    )
  }

  readCompose(path: string) {
    const file = { path, kind: 'compose file' } as const
    return pipe(
      this.readYaml(file),
      Effect.flatMap((document) => decodeCompose({ file, document })),
      Effect.withSpan('WorkspaceFiles.readCompose', { attributes: { path } }),
    )
  }

  private readYaml(file: WorkspaceFile) {
    return pipe(
      this.fileSystem.readFileString(file.path),
      Effect.flatMap((text) =>
        Effect.try({ try: () => Yaml.parse(text), catch: reasonOf }),
      ),
      Effect.mapError((cause) =>
        WorkspaceFileError.invalid({
          ...file,
          reason: Predicate.isString(cause) ? cause : reasonOf(cause),
        }),
      ),
      Effect.withSpan('WorkspaceFiles.readYaml', {
        attributes: { path: file.path },
      }),
    )
  }
}

export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  WorkspaceFilesShape
>()('dokploy-deploy/WorkspaceFiles') {
  static readonly layer = Layer.effect(
    WorkspaceFiles,
    Effect.map(
      EffectService.all({ fileSystem: FileSystem.FileSystem }),
      ({ fileSystem }) => FileSystemWorkspaceFiles.make(fileSystem),
    ),
  )

  static readonly buildTestService = (
    shape: Partial<WorkspaceFilesShape> = {},
  ) =>
    WorkspaceFiles.of({
      readManifest: (path) =>
        Effect.fail(
          WorkspaceFileError.invalid({
            path,
            kind: 'manifest',
            reason: 'no manifest in this test',
          }),
        ),
      readCompose: (path) =>
        Effect.fail(
          WorkspaceFileError.invalid({
            path,
            kind: 'compose file',
            reason: 'no compose file in this test',
          }),
        ),
      ...shape,
    })

  static readonly testLayer = Layer.succeed(
    WorkspaceFiles,
    WorkspaceFiles.buildTestService(),
  )

  static readonly buildTestLayer = (
    shape: Partial<WorkspaceFilesShape>,
  ): Layer.Layer<WorkspaceFiles> =>
    Layer.succeed(WorkspaceFiles, WorkspaceFiles.buildTestService(shape))
}
