import { Cause, Effect } from 'effect'
import type { LogLevel } from 'effect'

export type LogAnnotations = Readonly<Record<string, unknown>> & {
  readonly cause?: Cause.Cause<unknown>
}

function logAt(level: LogLevel.Severity) {
  return (
    message: string,
    annotations: LogAnnotations = {},
  ): Effect.Effect<void> => {
    const { cause = Cause.empty, ...lineAnnotations } = annotations
    return Effect.annotateLogs(
      Effect.logWithLevel(level)(message, cause),
      lineAnnotations,
    )
  }
}

export const debug = logAt('Debug')

export const info = logAt('Info')

export const warning = logAt('Warn')

export const error = logAt('Error')
