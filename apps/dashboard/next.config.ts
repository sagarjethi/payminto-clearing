import { resolve } from "node:path";
import type { NextConfig } from "next";

// The Docker image builds with NEXT_OUTPUT=standalone; tracing starts at the monorepo root so workspace packages are included.
const standalone = process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const, outputFileTracingRoot: resolve(process.cwd(), "../..") } : {};

const nextConfig: NextConfig = {
  ...standalone,
  transpilePackages: ["@payminto/protocol"],
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
