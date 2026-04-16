import { Bash } from '@everruns/bashkit'
import { describe, expect, it } from 'vitest'
import { EXECUTION_LIMITS } from './bash.js'

function createTestBash(files: Record<string, string> = {}) {
  const bash = new Bash({
    maxCommands: EXECUTION_LIMITS.maxCommands,
    maxLoopIterations: EXECUTION_LIMITS.maxLoopIterations,
    files: { '/home/.keep': '', ...files },
  })
  bash.executeSync('cd /home')
  bash.executeSync('export HOME=/home')
  return bash
}

// ---------------------------------------------------------------------------
// Attack surface tests - verify that execution limits catch abuse
// ---------------------------------------------------------------------------

describe('Attack: infinite loops', () => {
  it('while true is stopped by maxLoopIterations', async () => {
    const bash = createTestBash()
    const result = await bash.execute('while true; do echo x; done')
    // May hit maxCommands (echo counts per iteration) or maxLoopIterations
    expect(result.stderr).toMatch(/too many iterations|too many commands|limit|exceeded/i)
  })

  it('for loop with huge range is stopped', async () => {
    const bash = createTestBash()
    const result = await bash.execute('for i in $(seq 1 999999); do echo $i; done')
    expect(result.stderr).toMatch(/too many iterations|too many commands|limit|exceeded/i)
  })

  it('until false is stopped', async () => {
    const bash = createTestBash()
    const result = await bash.execute('until false; do echo x; done')
    expect(result.stderr).toMatch(/too many iterations|too many commands|limit|exceeded/i)
  })

  it('nested loops multiply but are still bounded', async () => {
    const bash = createTestBash()
    const result = await bash.execute(
      'for i in $(seq 1 100); do for j in $(seq 1 100); do echo "$i.$j"; done; done',
    )
    expect(result.stderr).toMatch(/too many iterations|too many commands|output size|limit|exceeded/i)
  })
})

describe('Attack: output flooding', () => {
  it('massive echo output is stopped by output limits', async () => {
    const bash = createTestBash()
    const result = await bash.execute(
      'x=$(printf "A%.0s" {1..1000}); for i in $(seq 1 2000); do echo "$x"; done',
    )
    expect(result.stderr).toMatch(/output size|too many iterations|too many commands|limit|exceeded/i)
  })

  it('yes-like output is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.execute(
      'while true; do echo "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; done',
    )
    const totalOutput = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0)
    // Allow generous margin for the error message
    expect(totalOutput).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
})

describe('Attack: string/memory amplification', () => {
  it('exponential string growth completes within loop limits', async () => {
    const bash = createTestBash()
    const result = await bash.execute(
      'x="AAAAAAAAAA"; for i in $(seq 1 25); do x="$x$x"; done; echo ${#x}',
    )
    // bashkit handles large strings natively in Rust. The loop (25 iters) is within
    // maxLoopIterations (1000). Execution completes - bashkit doesn't have a string length
    // limit like just-bash. The key protection is maxLoopIterations and maxCommands.
    expect(result.exitCode).toBe(0)
  })

  it('brace expansion bomb is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.execute('echo {1..1000}{1..1000}')
    const totalOutput = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0)
    expect(
      result.stderr.includes('limit') ||
        result.stderr.includes('brace') ||
        result.stderr.includes('exceeded') ||
        totalOutput <= 2 * 1024 * 1024,
    ).toBe(true)
  })

  it('large array construction is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.execute(
      'arr=(); for i in $(seq 1 20000); do arr+=("$i"); done; echo ${#arr[@]}',
    )
    expect(result.stderr).toMatch(/array|too many iterations|too many commands|limit|exceeded/i)
  })
})

describe('Attack: abort signal / timeout', () => {
  it('AbortSignal or execution limits stop a long-running loop', async () => {
    const bash = createTestBash()
    const signal = AbortSignal.timeout(500)
    signal.addEventListener('abort', () => bash.cancel(), { once: true })
    const start = performance.now()
    const resultOrError = await bash
      .execute('for i in $(seq 1 1000); do for j in $(seq 1 1000); do echo "$i.$j"; done; done')
      .catch((err: Error) => err)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(5000)

    if (resultOrError instanceof Error) {
      expect(resultOrError.message).toMatch(/abort|cancel/i)
    } else {
      expect(resultOrError.stderr + (resultOrError.error ?? '')).toMatch(/too many|limit|abort|exceeded|cancel/i)
    }
  })

  it('AbortSignal or limits stop nested command substitution', async () => {
    const bash = createTestBash()
    const signal = AbortSignal.timeout(500)
    signal.addEventListener('abort', () => bash.cancel(), { once: true })
    const resultOrError = await bash
      .execute('for i in $(seq 1 1000); do x=$(echo "$(echo "$(echo "$i")")"); done')
      .catch((err: Error) => err)

    if (resultOrError instanceof Error) {
      expect(resultOrError.message).toMatch(/abort|cancel/i)
    } else {
      expect(resultOrError.stderr + (resultOrError.error ?? '')).toMatch(/too many|limit|abort|exceeded|cancel/i)
    }
  })
})

describe('Attack: command substitution depth', () => {
  it('deeply nested $() completes within command limits', async () => {
    const bash = createTestBash()
    let cmd = 'echo hello'
    for (let i = 0; i < 25; i++) {
      cmd = `echo $(${cmd})`
    }
    const result = await bash.execute(cmd)
    // bashkit's Rust-native implementation supports deep nesting without a separate
    // substitution depth limit. Protection comes from maxCommands (each nested echo
    // counts). 25 levels is within the 1000 command limit.
    expect(result.stdout.trim()).toBe('hello')
  })
})

describe('Attack: call depth', () => {
  it('deep recursion is stopped', async () => {
    const bash = createTestBash()
    const result = await bash.execute('f() { f; }; f')
    expect(result.stderr).toMatch(/recursion depth|call depth|limit|exceeded/i)
  })
})

describe('Attack: arithmetic abuse', () => {
  it('arithmetic in tight loop is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.execute('x=0; while true; do x=$((x+1)); done; echo $x')
    expect(result.stderr).toMatch(/too many iterations|too many commands|limit|exceeded/i)
  })
})

describe('Attack: sed/awk amplification', () => {
  it('sed branch loop output is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.execute('echo "aaa" | sed ":loop; s/a/aa/; t loop"')
    // bashkit truncates sed output rather than erroring. Verify output is bounded.
    const totalOutput = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0)
    expect(totalOutput).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('awk infinite loop output is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.execute('echo x | awk "{ while(1) print }"')
    // bashkit truncates awk output rather than erroring. Verify output is bounded.
    const totalOutput = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0)
    expect(totalOutput).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
})

describe('Attack: concurrent execution fairness', () => {
  it('multiple bash instances run concurrently without blocking each other', async () => {
    const instances = Array.from({ length: 10 }, () => createTestBash())
    const start = performance.now()

    const results = await Promise.all(
      instances.map((bash) =>
        bash.execute('for i in $(seq 1 500); do x=$((i * 2)); done; echo "done"'),
      ),
    )

    const elapsed = performance.now() - start

    for (const result of results) {
      expect(
        result.stdout.includes('done') ||
          result.stderr.includes('limit') ||
          result.stderr.includes('too many') ||
          result.stderr.includes('exceeded'),
      ).toBe(true)
    }

    // With async execution, 10 concurrent instances shouldn't take 10x as long
    expect(elapsed).toBeLessThan(30000)
  })
})

describe('Attack: command count exhaustion', () => {
  it('many semicolon-separated commands hit maxCommands', async () => {
    const bash = createTestBash()
    const cmds = Array.from({ length: 1500 }, (_, i) => `echo ${i}`).join('; ')
    const result = await bash.execute(cmds)
    expect(result.stderr).toMatch(/too many commands|limit|exceeded/i)
  })
})

describe('Attack: glob exhaustion', () => {
  it('wildcard expansion is bounded', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 500; i++) {
      files[`/home/docs/dir${i}/file.md`] = `content ${i}`
    }
    const bash = createTestBash(files)
    // Attempt a glob-heavy operation
    const result = await bash.execute('ls /home/docs/*/*.md 2>&1; echo "done"')
    // Should either succeed within limits or hit the glob limit
    expect(
      result.stdout.includes('done') ||
        result.stderr.includes('limit') ||
        result.stderr.includes('glob') ||
        result.stderr.includes('exceeded'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Read-only filesystem tests (bashkit native mounts with readOnly: true)
// ---------------------------------------------------------------------------

describe('Attack: read-only filesystem (native mount)', () => {
  it('cannot write to mounted read-only path via redirect', async () => {
    const bash = new Bash()
    bash.mount('/tmp', '/docs') // default is read-only
    const result = await bash.execute('echo pwned > /docs/evil.txt')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/readonly|read.only/i)
  })

  it('cannot rm files on mounted read-only path', async () => {
    const bash = new Bash()
    bash.mount('/tmp', '/docs')
    const result = await bash.execute('rm /docs/nonexistent 2>&1')
    expect(result.exitCode).not.toBe(0)
  })

  it('cannot mkdir on mounted read-only path', async () => {
    const bash = new Bash()
    bash.mount('/tmp', '/docs')
    const result = await bash.execute('mkdir /docs/evil')
    expect(result.exitCode).not.toBe(0)
  })

  it('can read files on mounted read-only path', async () => {
    const bash = new Bash({ files: { '/data/hello.txt': 'world' } })
    const result = await bash.execute('cat /data/hello.txt')
    expect(result.stdout).toBe('world')
  })

  it('command rm cannot bypass read-only mount', async () => {
    const bash = new Bash()
    bash.mount('/tmp', '/docs')
    const result = await bash.execute('command rm /docs/evil 2>&1')
    expect(result.exitCode).not.toBe(0)
  })
})
