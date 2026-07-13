import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildApp } from './app.js'
import { loadConfig } from './config.js'

export async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const app = buildApp(config)
  await app.listen({ host: '0.0.0.0', port: config.port })

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    void app.close().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void main().catch(() => {
    console.error('Server failed to start')
    process.exitCode = 1
  })
}
