import { resolve } from 'node:path'
import { Bash, type ExecResult } from '@everruns/bashkit'

const DEFAULT_DOCS_DIR = resolve(process.env.DOCS_DIR ?? './docs')

export const EXECUTION_LIMITS = {
  maxCommands: 1000,
  maxLoopIterations: 1000,
}

const INSTRUCTIONS = `\`\`\`bash
# Search for a topic
ssh supabase.sh grep -rl 'auth' /supabase/docs/

# Read a specific guide
ssh supabase.sh cat /supabase/docs/guides/auth/passwords.md

# Find all guides in a section
ssh supabase.sh find /supabase/docs/guides/database -name '*.md'

# Search with context
ssh supabase.sh grep -r 'RLS' /supabase/docs/guides/auth --include='*.md' -l
\`\`\`

All docs live under \`/supabase/docs/\` as markdown files. You can use any standard Unix tools (grep, find, cat, etc.) to search and read them.`

const AGENTS_MD = `## Supabase Docs

Before working on a Supabase feature, check the docs via \`ssh supabase.sh <command>\`.

${INSTRUCTIONS}
`

const SKILL_MD = `---
name: supabase-docs
description: Search and read Supabase documentation using a bash shell. Use when working on a Supabase feature or troubleshooting a problem.
---

# Supabase Docs

Search and read Supabase documentation over SSH.

## How to use

${INSTRUCTIONS}
`

const SETUP_MD = `# Supabase Docs - Setup

You are helping a user set up access to Supabase documentation via SSH.

1. First tell them the purpose of this tool (docs over ssh/bash)
2. Ask the user which option they prefer (use AskUserQuestion or similar if available)

Options:

1. **Append to agent instructions file (recommended)** - Adds lightweight instructions to the project's agent config file. Most reliable since instructions are always loaded and the footprint is small.
2. **Install as a skill** - Creates a skill directory with a SKILL.md. Skills are loaded on-demand but not always reliable.
3. **Both** - Adds to agent instructions and installs the skill.

After the user chooses, follow the steps below. If you are unsure which agent or tool the user is using, ask them.

## Option 1: Agent instructions file

Run this command and append the output to the project's agent instructions file:

\`\`\`bash
ssh supabase.sh agents >> <instructions-file>
\`\`\`

Common instructions files by tool:

| Tool | File |
|------|------|
| Claude Code | \`CLAUDE.md\` |
| GitHub Copilot | \`AGENTS.md\` |
| Codex | \`AGENTS.md\` |
| Gemini CLI | \`GEMINI.md\` |
| Cursor | \`AGENTS.md\` |
| OpenCode | \`AGENTS.md\` |
| Other | \`AGENTS.md\` |

## Option 2: Skill

Run this command and write the output to the skill directory.

Pick the path that matches the user's tool. \`.agents/skills/\` is a cross-client convention supported by most tools:

| Tool | Skill path |
|------|-----------|
| Claude Code | \`.claude/skills/supabase-docs/SKILL.md\` |
| Codex | \`.agents/skills/supabase-docs/SKILL.md\` |
| Cursor | \`.cursor/skills/supabase-docs/SKILL.md\` or \`.agents/skills/supabase-docs/SKILL.md\` |
| OpenCode | \`.opencode/skills/supabase-docs/SKILL.md\` or \`.agents/skills/supabase-docs/SKILL.md\` |
| Gemini CLI | \`.gemini/skills/supabase-docs/SKILL.md\` or \`.agents/skills/supabase-docs/SKILL.md\` |
| GitHub Copilot | \`.github/skills/supabase-docs/SKILL.md\` |
| Other | \`.agents/skills/supabase-docs/SKILL.md\` |

\`\`\`bash
mkdir -p <skill-dir>/supabase-docs
ssh supabase.sh skill > <skill-dir>/supabase-docs/SKILL.md
\`\`\`

## Option 3: Both

Run both sets of commands above.

After setup, confirm to the user what was written and where.
`

/**
 * Creates a sandboxed Bash instance with docs mounted as a read-only overlay.
 * @param docsDir - Path to docs directory to mount. Defaults to DOCS_DIR env or ./docs.
 */
export async function createBash(docsDir = DEFAULT_DOCS_DIR) {
  const bash = new Bash({
    files: {
      '/supabase/AGENTS.md': AGENTS_MD,
      '/supabase/SKILL.md': SKILL_MD,
      '/supabase/SETUP.md': SETUP_MD,
    },
    maxCommands: EXECUTION_LIMITS.maxCommands,
    maxLoopIterations: EXECUTION_LIMITS.maxLoopIterations,
  })

  // Mount docs as read-only (enforced at Rust VFS level).
  // Uses mount() method instead of mounts option due to bashkit bug where
  // readOnly is not enforced when mounts and files are combined in constructor.
  bash.mount(docsDir, '/supabase/docs')

  // Set up environment
  bash.executeSync('export HOME=/supabase')
  bash.executeSync('cd /supabase')

  // Set up aliases
  bash.executeSync('shopt -s expand_aliases')
  bash.executeSync("alias ll='ls -alF'")
  bash.executeSync("alias la='ls -a'")
  bash.executeSync("alias l='ls -CF'")
  bash.executeSync("alias agents='echo && cat /supabase/AGENTS.md'")
  bash.executeSync("alias skill='echo && cat /supabase/SKILL.md'")
  bash.executeSync("alias setup='cat /supabase/SETUP.md'")

  // Define ssh command as a bash function that prints a helpful error
  bash.executeSync(`ssh() {
  local cmd="\$*"
  local hint=""
  if [ "\$cmd" = "supabase.sh agents" ]; then hint=" >> AGENTS.md"; fi
  echo "ssh is not available from within this session." >&2
  echo "Exit first, then run:" >&2
  echo "" >&2
  echo "  ssh \$cmd\$hint" >&2
  echo "" >&2
  return 1
}`)

  return { bash }
}
