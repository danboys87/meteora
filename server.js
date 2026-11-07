// Server HTTP kecil untuk dashboard. Tanpa dependency.
// - Tanpa DASHBOARD_TOKEN: hanya bisa diakses dari komputer yang sama (127.0.0.1).
// - Dengan DASHBOARD_TOKEN: bisa diakses dari jaringan (HP), API wajib pakai ?token=...
// - POST /api/config (ubah pengaturan) mengikuti aturan yang sama, ditambah:
//   wajib Content-Type: application/json (mencegah form lintas-situs) dan Host harus localhost
//   saat tanpa token (mencegah DNS rebinding).
import http from "http";
import fs from "fs";

const MAX_BODY = 10_000;

export function startServer(getStatus, log, setConfig) {
  const port = Number(process.env.DASHBOARD_PORT || 8787);
  const token = process.env.DASHBOARD_TOKEN || "";
  const host = token ? "0.0.0.0" : "127.0.0.1";

  const json = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const authed = !token || u.searchParams.get("token") === token;

    if (u.pathname === "/api/status") {
      if (!authed) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("unauthorized"); }
      return json(res, 200, getStatus());
    }

    if (u.pathname === "/api/config" && req.method === "POST") {
      if (!authed) return json(res, 401, { ok: false, error: "unauthorized" });
      if (!token && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || ""))
        return json(res, 403, { ok: false, error: "host tidak diizinkan" });
      if (!(req.headers["content-type"] || "").startsWith("application/json"))
        return json(res, 415, { ok: false, error: "Content-Type harus application/json" });

      let body = "";
      let tooBig = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
      });
      req.on("end", () => {
        if (tooBig) return;
        try {
          const cfg = setConfig(JSON.parse(body));
          json(res, 200, { ok: true, cfg });
        } catch (e) {
          json(res, 400, { ok: false, error: e.message });
        }
      });
      return;
    }

    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(new URL("./dashboard.html", import.meta.url)));
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  server.on("error", (e) => log(`dashboard error: ${e.message}`));
  server.listen(port, host, () =>
    log(`Dashboard: http://${host === "0.0.0.0" ? "<IP-komputer>" : "localhost"}:${port}/${token ? "?token=<DASHBOARD_TOKEN>" : ""}`)
  );
}
