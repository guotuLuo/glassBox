import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // workspace 包是 TS 源码直出(exports 指向 src),由 Next 就地转译
  transpilePackages: ["@glassbox/contracts"],
};

export default nextConfig;
