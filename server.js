// Server HTTP kecil untuk dashboard. Tanpa dependency.
// - Tanpa DASHBOARD_TOKEN: hanya bisa diakses dari komputer yang sama (127.0.0.1).
// - Dengan DASHBOARD_TOKEN: bisa diakses dari jaringan (HP), API wajib pakai ?token=...
import http from "http";
import fs from "fs";

export function startServer(getStatus, log) {
  const port = Number(process.env.DASHBOARD_PORT || 8787);
  const token = process.env.DASHBOARD_TOKEN || "";
  const host = token ? "0.0.0.0" : "127.0.0.1";

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/api/status") {
      if (token && u.searchParams.get("token") !== token) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        return res.end("unauthorized");
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(getStatus()));
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
