import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@payminto/protocol"],
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
