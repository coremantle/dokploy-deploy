import { Schema } from 'effect'

export const DeployMode = Schema.Literals(['plan', 'apply'])

export type DeployMode = typeof DeployMode.Type
