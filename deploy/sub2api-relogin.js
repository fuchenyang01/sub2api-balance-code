const authStorageKeys = [
  'auth_token',
  'auth_user',
  'refresh_token',
  'token_expires_at',
  'pending_auth_session',
]

for (const key of authStorageKeys) localStorage.removeItem(key)

const redirectPath = new URLSearchParams(window.location.search).get('redirect')
let safeRedirect = ''

if (redirectPath !== null) {
  try {
    const redirectUrl = new URL(redirectPath, window.location.origin)
    if (
      redirectPath.startsWith('/')
      && redirectUrl.origin === window.location.origin
      && /^\/custom\/[A-Za-z0-9_-]+$/.test(redirectUrl.pathname)
      && redirectUrl.search === ''
      && redirectUrl.hash === ''
    ) {
      safeRedirect = redirectUrl.pathname
    }
  } catch {
    safeRedirect = ''
  }
}

const loginUrl = new URL('/login', window.location.origin)
if (safeRedirect !== '') loginUrl.searchParams.set('redirect', safeRedirect)
window.location.replace(loginUrl)
