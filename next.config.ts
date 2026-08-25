import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/CJS packages that must not be bundled by the server compiler.
  serverExternalPackages: ['ssh2', '@resvg/resvg-js'],
  // Emit a self-contained server bundle so the runtime image only needs Node —
  // no node_modules install at deploy time. Required by the Dockerfile.
  output: 'standalone',
};

export default nextConfig;
