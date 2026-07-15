import { z } from 'zod'

const nodeEnvironments = ['development', 'test', 'production'] as const
const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

const integerEnv = (defaultValue: number, minimum: number, maximum: number) =>
  z.preprocess(
    (value) => value ?? String(defaultValue),
    z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(minimum).max(maximum)),
  )

const requiredPositiveIntegerEnv = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))

const booleanEnv = (defaultValue: boolean) =>
  z.preprocess(
    (value) => value ?? String(defaultValue),
    z.enum(['true', 'false']).transform((value) => value === 'true'),
  )

const secretSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'must be at least 32 UTF-8 bytes')

const baseUrlSchema = z
  .string()
  .superRefine((value, context) => {
    try {
      const url = new URL(value)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        value.includes('?') ||
        value.includes('#')
      ) {
        context.addIssue({ code: 'custom', message: 'must be a safe HTTP(S) URL' })
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'must be a valid URL' })
    }
  })
  .transform((value) => {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.pathname === '/' ? url.origin : url.toString()
  })

const originSchema = z
  .string()
  .superRefine((value, context) => {
    try {
      const url = new URL(value)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username !== '' ||
        url.password !== '' ||
        (url.pathname !== '' && url.pathname !== '/') ||
        url.search !== '' ||
        url.hash !== '' ||
        value.includes('?') ||
        value.includes('#')
      ) {
        context.addIssue({ code: 'custom', message: 'must be an HTTP(S) origin' })
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'must be a valid origin' })
    }
  })
  .transform((value) => new URL(value).origin)

const envSchema = z.object({
  NODE_ENV: z.enum(nodeEnvironments).default('development'),
  SUB2API_BASE_URL: baseUrlSchema,
  SUB2API_ADMIN_API_KEY: z.string().startsWith('admin-'),
  REDEEM_ALLOWED_GROUP_ID: requiredPositiveIntegerEnv,
  APP_ORIGIN: originSchema,
  SUB2API_ORIGIN: originSchema,
  SESSION_SECRET: secretSchema,
  OPERATION_SIGNING_SECRET: secretSchema,
  PORT: integerEnv(3000, 1, 65_535),
  OPERATION_TTL_MINUTES: integerEnv(60, 1, 1_440),
  UPSTREAM_TIMEOUT_MS: integerEnv(10_000, 1_000, 60_000),
  TRUST_PROXY: booleanEnv(false),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  COOKIE_SECURE: booleanEnv(true),
})

export interface AppConfig {
  nodeEnv: (typeof nodeEnvironments)[number]
  port: number
  sub2apiBaseUrl: string
  sub2apiAdminApiKey: string
  redeemAllowedGroupId: number
  appOrigin: string
  sub2apiOrigin: string
  sessionSecret: string
  operationSigningSecret: string
  operationTtlMinutes: number
  upstreamTimeoutMs: number
  trustProxy: boolean
  logLevel: (typeof logLevels)[number]
  cookieSecure: boolean
}

export function loadConfig(input: NodeJS.ProcessEnv): Readonly<AppConfig> {
  const env = envSchema.parse(input)

  if (env.SESSION_SECRET === env.OPERATION_SIGNING_SECRET) {
    throw new Error('session and operation secrets must differ')
  }

  if (
    env.NODE_ENV === 'production' &&
    (new URL(env.SUB2API_BASE_URL).protocol !== 'https:' ||
      !env.APP_ORIGIN.startsWith('https://') ||
      !env.SUB2API_ORIGIN.startsWith('https://') ||
      !env.COOKIE_SECURE)
  ) {
    throw new Error('production origins and cookies must use HTTPS')
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    sub2apiBaseUrl: env.SUB2API_BASE_URL,
    sub2apiAdminApiKey: env.SUB2API_ADMIN_API_KEY,
    redeemAllowedGroupId: env.REDEEM_ALLOWED_GROUP_ID,
    appOrigin: env.APP_ORIGIN,
    sub2apiOrigin: env.SUB2API_ORIGIN,
    sessionSecret: env.SESSION_SECRET,
    operationSigningSecret: env.OPERATION_SIGNING_SECRET,
    operationTtlMinutes: env.OPERATION_TTL_MINUTES,
    upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
    trustProxy: env.TRUST_PROXY,
    logLevel: env.LOG_LEVEL,
    cookieSecure: env.COOKIE_SECURE,
  })
}
