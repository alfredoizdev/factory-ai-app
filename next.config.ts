import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e suite builds into its own folder so it can run beside a `next dev` you already have open.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The dev-mode badge sits in the bottom-left corner, on top of the sidebar's log panel.
  devIndicators: false,
  // The browser that takes before and after pictures is loaded by Node at run time, never bundled.
  serverExternalPackages: ['@playwright/test', 'playwright', 'playwright-core'],
};

export default nextConfig;
