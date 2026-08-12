/**
 * `plano` — PLANO mesh CLI entry (plan v5 A1). A thin JSON-RPC client exactly like Orca's:
 * parse args → dispatch one command → print. No app state, no PTYs; every command is one POST
 * to the daemon's mesh endpoint, attributed by PLANO_MESH_TOKEN.
 *
 * Runs under ELECTRON_RUN_AS_NODE (the launcher in <userData>/bin) or plain node — it only
 * uses node builtins.
 */

import { MeshClient, MeshCliError } from './client'
import { run, type ParsedArgs } from './commands'
import { specFor, helpText, agentContextJson, type CommandSpec } from './spec'

const VERSION = '5.0.0'

function usageError(message: string): MeshCliError {
  return new MeshCliError('usage', message, 1)
}

/** Token walk: flags anywhere, `--` makes the rest literal, command = first 1-2 non-flag tokens. */
function parse(argv: string[]): ParsedArgs {
  const nonFlag = argv.filter((t) => t !== '--' && !t.startsWith('--'))
  const { key, spec } = specFor(nonFlag)
  const cmdLen = key.includes(' ') ? 2 : key ? 1 : 0
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let literal = false
  let seen = 0
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (!literal && t === '--') {
      literal = true
      continue
    }
    if (!literal && t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(2, eq) : t.slice(2)
      const inline = eq >= 0 ? t.slice(eq + 1) : undefined
      const fspec = (spec?.flags ?? []).find((f) => f.flag === `--${name}`)
      if (fspec?.arg) {
        if (inline !== undefined) flags[name] = inline
        else if (i + 1 < argv.length) {
          flags[name] = argv[i + 1]
          i += 1
        } else {
          throw usageError(`--${name} requires a value`)
        }
      } else {
        flags[name] = inline ?? true
      }
      continue
    }
    if (seen < cmdLen) {
      seen += 1
      continue
    }
    positional.push(t)
  }
  return { key, positional, flags }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    console.log(helpText())
    return 0
  }
  const parsed = parse(argv)
  const spec: CommandSpec | undefined = specFor([parsed.key]).spec

  if (parsed.key === 'help') {
    console.log(helpText(parsed.positional[0]))
    return 0
  }
  if (parsed.flags.help === true) {
    console.log(helpText(spec?.command))
    return 0
  }
  if (parsed.key === 'version') {
    console.log(`plano ${VERSION}`)
    return 0
  }
  if (parsed.key === 'agent-context') {
    console.log(agentContextJson())
    return 0
  }
  const client = new MeshClient()
  const { output, exitCode } = await run(parsed.key, parsed, client)
  if (output) console.log(output)
  return exitCode
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    if (err instanceof MeshCliError) {
      console.error(`plano: ${err.message}`)
      process.exitCode = err.exitCode
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`plano: ${message}`)
    process.exitCode = 1
  })
