import { writeFileSync } from 'node:fs'

import { manifestJsonSchema } from '#manifest/manifest.ts'

writeFileSync(
  new URL('../manifest.schema.json', import.meta.url),
  `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`,
)
