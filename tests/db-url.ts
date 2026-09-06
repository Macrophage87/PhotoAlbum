/** Rewrite a Postgres URL so its database name ends in `_test`; a query string is preserved. */
export function testDatabaseUrl(url: string): string {
  return url.replace(/\/([^/?]+)(\?.*)?$/, (_m, name: string, qs = "") => (name.endsWith("_test") ? `/${name}${qs}` : `/${name}_test${qs}`));
}
