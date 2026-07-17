import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const repositoryFile = (name: string): string =>
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

const sectionBetween = (content: string, start: string, end: string): string => {
  const startIndex = content.indexOf(start)
  const endIndex = content.indexOf(end, startIndex + start.length)

  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)

  return content.slice(startIndex, endIndex)
}

describe('deployment contracts', () => {
  it('checks container health on the configured application port', () => {
    expect(repositoryFile('Dockerfile')).toMatch(
      /HEALTHCHECK[^\r\n]*http:\/\/127\.0\.0\.1:\$\{PORT:-3000\}\/healthz/,
    )
  })

  it('documents the matching container port when PORT is customized', () => {
    const readme = repositoryFile('README.md')
    expect(readme).toContain('`PORT=4000`')
    expect(readme).toContain('`-p 127.0.0.1:3100:4000`')
  })

  it('documents the dedicated redemption group boundary', () => {
    const readme = repositoryFile('README.md')
    const setup = sectionBetween(
      readme,
      '### 2. 创建分销专属分组',
      '### 3. 下载项目',
    )

    expect(readme).toContain('服务端会在关键步骤重新向 sub2api 验证')
    expect(setup).toContain('实时 profile')
    expect(setup).toContain('`allowed_groups`')
    expect(setup).toContain('已启用的**专属分组**')
    expect(setup).toMatch(/公开分组.*不适合.*授权边界/)
    expect(setup).toContain('工具无法确认该分组是否为“启用”或“专属”')
    expect(setup).toContain('用户管理 → 分组配置')
    expect(setup).toContain('`#24` 对应配置值 `24`')
  })

  it('documents the allowed group in production, local, and reference config', () => {
    const readme = repositoryFile('README.md')
    const production = sectionBetween(
      readme,
      '### 4. 配置 `.env`',
      '### 5. 构建并启动单个容器',
    )
    const reference = sectionBetween(
      readme,
      '## 必要配置',
      '## 日常维护',
    )
    const local = sectionBetween(readme, '## 本地开发', '## 开源地址')
    const envExample = repositoryFile('.env.example')

    expect(production).toMatch(
      /SUB2API_ADMIN_API_KEY=REPLACE_ME_ADMIN_KEY\r?\nREDEEM_ALLOWED_GROUP_ID=24/,
    )
    expect(production).toContain('只填数字，不带 `#`')
    expect(reference).toContain('`REDEEM_ALLOWED_GROUP_ID`')
    expect(local).toContain('cp .env.example .env')
    expect(envExample).toContain('REDEEM_ALLOWED_GROUP_ID=24')
  })

  it('ships and documents the same-origin relogin bridge required for expired sessions', () => {
    const readme = repositoryFile('README.md')
    const envExample = repositoryFile('.env.example')
    const bridgeHtml = repositoryFile('deploy/sub2api-relogin.html')
    const bridgeScript = repositoryFile('deploy/sub2api-relogin.js')

    expect(envExample).toContain(
      'SUB2API_ENTRY_URL=https://sub2api.example.com/custom/balance-code',
    )
    expect(readme).toContain('SUB2API_ENTRY_URL=https://www.cyapi.cyou/custom/71038ae6498c1ecb')
    expect(readme).toContain('必须与 `SUB2API_ORIGIN` 同源')
    expect(readme).toContain('登录状态已过期')
    expect(readme).toContain('重新登录并进入')
    expect(readme).toContain('deploy/sub2api-relogin.html')
    expect(readme).toContain('deploy/sub2api-relogin.js')
    expect(readme).toContain('location = /balance-code-relogin')
    expect(readme).toContain('location = /balance-code-relogin.js')
    expect(readme).toContain("frame-ancestors 'none'")
    expect(readme).toContain('X-Content-Type-Options "nosniff" always')
    expect(readme).toContain('Referrer-Policy "no-referrer" always')
    expect(readme).toContain('Cache-Control "no-store" always')
    expect(bridgeHtml).toContain('<script src="/balance-code-relogin.js" defer></script>')
    expect(bridgeScript).toContain("localStorage.removeItem(key)")
    expect(bridgeScript).toContain("new URL('/login', window.location.origin)")
  })

  it('documents the allowed-group migration before replacing a deployment', () => {
    const readme = repositoryFile('README.md')
    const maintenance = sectionBetween(readme, '## 日常维护', '## 重要限制')

    expect(maintenance).toContain('对照最新的 `.env.example`')
    expect(maintenance).toContain('REDEEM_ALLOWED_GROUP_ID=24')
    expect(maintenance).toContain('按实际专属分组 ID 填写')
    expect(maintenance).toContain('缺少该变量会导致新容器拒绝启动')

    const pullIndex = maintenance.indexOf('git pull --ff-only')
    const allowedGroupIndex = maintenance.indexOf('REDEEM_ALLOWED_GROUP_ID=24')
    const buildIndex = maintenance.indexOf('sudo docker build')
    const removeIndex = maintenance.indexOf('sudo docker rm -f')

    expect(pullIndex).toBeGreaterThanOrEqual(0)
    expect(allowedGroupIndex).toBeGreaterThan(pullIndex)
    expect(buildIndex).toBeGreaterThan(allowedGroupIndex)
    expect(removeIndex).toBeGreaterThan(buildIndex)
  })

  it('documents access denial checks and custom menu limits', () => {
    const readme = repositoryFile('README.md')

    expect(readme).toContain('不能按专属分组隐藏')
    expect(readme).toContain('未授权用户可能看见入口')
    expect(readme).toContain('403 / REDEEM_ACCESS_DENIED')
    expect(readme).toContain('确认分组是已启用的专属分组')
    expect(readme).toContain('确认用户已勾选该分组')
    expect(readme).toContain('删除并重建容器')
    expect(readme).toMatch(/用户被移出分组后.*立即失去权限/)
    expect(readme).toMatch(/重新加入分组后.*点击“重新检查”/)
    expect(readme).toMatch(
      /REDEEM_ALLOWED_GROUP_ID.*实际分组 ID.*不一致.*服务可以启动.*用户.*无权限/,
    )
    expect(readme).not.toMatch(/SUB2API_ADMIN_API_KEY=admin-[^\s]+/)
    expect(readme).not.toMatch(/[?&]token=(?!\.\.\.)[A-Za-z0-9_-]{16,}/)
  })

  it('keeps concrete same-site and local iframe examples', () => {
    const readme = repositoryFile('README.md')
    const prerequisites = sectionBetween(
      readme,
      '### 1. 准备信息',
      '### 2. 创建分销专属分组',
    )

    expect(prerequisites).toContain('https://www.cyapi.cyou')
    expect(prerequisites).toContain('https://code.cyapi.cyou')
    expect(prerequisites).toContain('http://localhost:5173')
    expect(prerequisites).toContain('本地调试应使用“新窗口打开”')
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
