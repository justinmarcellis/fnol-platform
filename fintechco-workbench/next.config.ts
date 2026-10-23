import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // seed-workspace and verified-patches are read at runtime from process.cwd().
  outputFileTracingExcludes: { "*": ["./seed-workspace/**", "./verified-patches/**"] },
};

export default nextConfig;
