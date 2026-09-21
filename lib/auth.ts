export function expectedUser(): string {
  return (process.env.ADMIN_USER || "admin").trim();
}

export function checkLogin(username: string, password: string): { ok: true } | { ok: false; error: string } {
  const expectedPassword = process.env.ADMIN_PASSWORD || "";
  if (!expectedPassword) {
    return {
      ok: false,
      error: "Vercel'de ADMIN_PASSWORD boş. Proje → Settings → Environment Variables kısmına bir şifre yaz, sonra Redeploy yap.",
    };
  }
  if (username.trim() !== expectedUser() || password !== expectedPassword) {
    return { ok: false, error: `Kullanıcı adı veya şifre yanlış. Kullanıcı adı: ${expectedUser()}` };
  }
  return { ok: true };
}

export function adminOk(request: Request): boolean {
  return checkLogin(
    request.headers.get("x-admin-user") || "",
    request.headers.get("x-admin-password") || "",
  ).ok;
}

export function cronOk(request: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export function scanOk(request: Request): boolean {
  return cronOk(request) || adminOk(request);
}
