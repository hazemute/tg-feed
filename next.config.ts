import type { NextConfig } from "next";
import { config } from "dotenv";

// .env (gitignored) — источник истины для локальной среды. Песочница/CI могут
// экспортировать устаревшие DATABASE_URL/DIRECT_URL в process.env — Next их
// не перекрывает, поэтому форсим значения из .env. На Vercel файла .env нет,
// конфиг собирается из Variables — вызов безопасный no-op.
config({ override: true });

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Anti-scan: не раскрываем стек (X-Powered-By: Next.js) в ответах
  poweredByHeader: false,
  // Security-заголовки на все ответы (в т.ч. статику).
  // ВАЖНО: X-Frame-Options НЕ ставим — мини-апп работает в iframe Telegram Web
  // (web.telegram.org). Вместо него — CSP frame-ancestors с allowlist Telegram.
  async headers() {
    const frameAncestors =
      "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://telegram.org https://*.telegram.org https://*.t.me https://localhost:8080 http://localhost:8080;";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Content-Security-Policy",
            value: frameAncestors,
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Origin-Agent-Cluster", value: "?1" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
      {
        // Админ-панель: фреймить извне нельзя никому (кроме самого приложения)
        source: "/admin/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
