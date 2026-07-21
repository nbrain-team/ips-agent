import type { NextConfig } from "next";

// Same-origin proxy: /api/* and /socket.io/* go to the backend so cookies
// and the WebSocket handshake "just work" (Part 6.4).
const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8080";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/socket.io/:path*", destination: `${BACKEND_URL}/socket.io/:path*` },
      { source: "/health", destination: `${BACKEND_URL}/health` },
    ];
  },
};

export default nextConfig;
