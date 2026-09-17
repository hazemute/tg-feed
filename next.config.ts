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
  // Security-заголовки на все ответы (в т.ч. статику)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Origin-Agent-Cluster", value: "?1" },
        ],
      },
    ];
  },
};

export default nextConfig;
