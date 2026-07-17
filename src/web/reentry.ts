export function sessionReentryTarget(embedded: boolean): '_top' | '_self' {
  return embedded ? '_top' : '_self'
}
