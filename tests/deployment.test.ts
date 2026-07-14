import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const repositoryFile = (name: string): string =>
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

describe('deployment contracts', () => {
  it('checks container health on the configured application port', () => {
    expect(repositoryFile('Dockerfile')).toMatch(
      /HEALTHCHECK[^\r\n]*http:\/\/127\.0\.0\.1:\$\{PORT:-3000\}\/healthz/,
    )
  })

  it('documents the matching container port when PORT is customized', () => {
    const readme = repositoryFile('README.md')
    expect(readme).toContain('PORT=4000')
    expect(readme).toContain('-p 127.0.0.1:3100:4000')
  })

  it('loads the local server environment from .env in the dev command', () => {
    const packageJson = JSON.parse(repositoryFile('package.json')) as {
      scripts?: Record<string, string>
    }
    expect(packageJson.scripts?.dev).toBe(
      'tsx watch --env-file=.env src/server/main.ts',
    )
  })
})
