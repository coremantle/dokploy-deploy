# oxlint-plugin

The Effect convention rules of `ddd-template`
(`packages/tooling/oxlint-plugin/src`), copied as they are and loaded through
`jsPlugins` in [`../oxlint-config/base.json`](../oxlint-config/base.json).
Rules keep their `template/` prefix so the two repositories stay
interchangeable.

Left out: `no-unlocalized-string` (it only targets JSX copy). The rule tests
stay in `ddd-template`; to change a rule, change it there, then copy the file
again.
