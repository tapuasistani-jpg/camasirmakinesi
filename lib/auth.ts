export function adminOk(request: Request): boolean {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  return request.headers.get("x-admin-password") === expected;
}

export function cronOk(request: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export function scanOk(request: Request): boolean {
  return cronOk(request) || adminOk(request);
}
