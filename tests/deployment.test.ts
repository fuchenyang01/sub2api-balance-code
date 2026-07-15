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
    expect(readme).toContain('PORT=4000')
    expect(readme).toContain('-p 127.0.0.1:3100:4000')
  })

  it('documents dedicated redemption group setup in sub2api', () => {
    const readme = repositoryFile('README.md')
    const setup = sectionBetween(
      readme,
      '#### 4.1 创建允许兑换的专属分组',
      '### 第 5 步：下载项目',
    )

    expect(readme).toContain('服务端会在每次受保护请求中重新验证')
    expect(setup).toContain('登录 sub2api 管理后台')
    expect(setup).toContain('分组管理')
    expect(setup).toContain('分销代理')
    expect(setup).toMatch(/启用状态.*专属分组/)
    expect(setup).toMatch(/公开分组.*不适合.*权限.*专属分组/)
    expect(setup).toContain('列设置')
    expect(setup).toContain('`#24`')
    expect(setup).toContain('用户管理')
    expect(setup).toContain('分组配置')
    expect(setup).toContain('勾选“分销代理”专属分组')
  })

  it('documents the allowed group in production, local, and reference env sections', () => {
    const readme = repositoryFile('README.md')
    const production = sectionBetween(
      readme,
      '### 第 6 步：填写生产环境配置',
      '### 第 7 步：构建并启动容器',
    )
    const local = sectionBetween(
      readme,
      '本地 `.env` 示例：',
      '开发模式下 Vite',
    )

    expect(production).toMatch(
      /SUB2API_ADMIN_API_KEY=REPLACE_ME_ADMIN_KEY\r?\nREDEEM_ALLOWED_GROUP_ID=24/,
    )
    expect(local).toMatch(
      /SUB2API_ADMIN_API_KEY=REPLACE_ME_ADMIN_KEY\r?\nREDEEM_ALLOWED_GROUP_ID=24/,
    )
    expect(production).toContain('`#24` 对应填写 `24`，不要填写 `#24`')
    expect(production).toContain('修改 `.env` 后必须删除并重建容器')
    expect(readme).toMatch(
      /^\| `REDEEM_ALLOWED_GROUP_ID` \| 无，必填 \|.*正整数.*只填数字.*24.*\|$/m,
    )
  })

  it('documents access denial troubleshooting and custom menu limits', () => {
    const readme = repositoryFile('README.md')
    const menu = sectionBetween(
      readme,
      '### 第 10 步：在 sub2api 添加自定义菜单',
      '### 第 11 步：完成上线验收',
    )
    const troubleshooting = sectionBetween(
      readme,
      '### 页面显示“暂无余额兑换权限”',
      '### 生成兑换码后余额没有刷新',
    )

    expect(menu).toMatch(/自定义菜单.*普通用户可见.*管理员可见/)
    expect(menu).toContain('不能按专属分组隐藏')
    expect(menu).toContain('未授权用户也可能看见入口')
    expect(menu).toContain('本工具不修改 sub2api')
    expect(troubleshooting).toContain('HTTP 403')
    expect(troubleshooting).toContain('`REDEEM_ACCESS_DENIED`')
    expect(troubleshooting).toContain('已启用的专属分组')
    expect(troubleshooting).toContain('用户已勾选')
    expect(troubleshooting).toContain('删除并重建容器')
    expect(troubleshooting).toMatch(
      /用户被移出专属分组后.*立即返回 HTTP 403/,
    )
    expect(troubleshooting).toMatch(
      /重新加入并保存分组后.*点击“重新检查”/,
    )
    expect(readme).not.toContain('cyapi.cyou')
    expect(readme).not.toMatch(/SUB2API_ADMIN_API_KEY=admin-[^\s]+/)
    expect(readme).not.toMatch(/[?&]token=(?!\.\.\.)[A-Za-z0-9_-]{16,}/)
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
