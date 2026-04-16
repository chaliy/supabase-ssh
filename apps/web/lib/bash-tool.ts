import type { ExecResult } from '@everruns/bashkit'
import { Bash } from '@everruns/bashkit'

const EXEC_API_URL = process.env.EXEC_API_URL ?? 'https://supabase.sh/api/exec'

const TIMEOUT_MS = 15_000

/**
 * Handle the custom `ssh` command by intercepting it before bash execution.
 * Routes `ssh supabase.sh <cmd>` to the exec API.
 */
async function handleSshCommand(args: string[]): Promise<ExecResult> {
  const [target, ...rest] = args

  if (target !== 'supabase.sh') {
    return {
      stdout: '',
      stderr: `ssh: only supabase.sh is supported as a remote target\n`,
      exitCode: 255,
    }
  }

  if (rest.length === 0) {
    return {
      stdout: '',
      stderr: `usage: ssh supabase.sh <command>\n`,
      exitCode: 1,
    }
  }

  const command = rest.join(' ')

  let res: Response
  try {
    res = await fetch(EXEC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    return {
      stdout: '',
      stderr: `ssh: connection failed: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 255,
    }
  }

  const body = (await res.json()) as {
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
  }

  if (!res.ok) {
    return {
      stdout: '',
      stderr: `ssh: remote error: ${body.error ?? `HTTP ${res.status}`}\n`,
      exitCode: 1,
    }
  }

  return {
    stdout: body.stdout ?? '',
    stderr: body.stderr ?? '',
    exitCode: body.exitCode ?? 0,
  }
}

/**
 * Parse an ssh command from a command string.
 * Returns the args after 'ssh' if the command starts with ssh, otherwise null.
 */
function parseSshCommand(command: string): string[] | null {
  const trimmed = command.trim()
  if (!trimmed.startsWith('ssh ')) return null
  // Split on whitespace, skip 'ssh'
  const parts = trimmed.split(/\s+/)
  return parts.slice(1)
}

/**
 * Execute a bash command in an isolated in-memory shell.
 * The `ssh supabase.sh <cmd>` command routes to EXEC_API_URL.
 */
export async function executeBashCommand(command: string): Promise<ExecResult> {
  // Intercept ssh commands before passing to bash
  const sshArgs = parseSshCommand(command)
  if (sshArgs) {
    return handleSshCommand(sshArgs)
  }

  const bash = new Bash({
    maxCommands: 1000,
    maxLoopIterations: 1000,
  })
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  signal.addEventListener('abort', () => bash.cancel(), { once: true })
  return bash.execute(command)
}
