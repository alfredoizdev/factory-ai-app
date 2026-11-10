import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e suite builds into its own folder so it can run beside a `next dev` you already have open.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
};

export default nextConfig;
