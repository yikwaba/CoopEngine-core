/** @type {import('next').NextConfig} */
const nextConfig = {
  // Verification runs on the live host. Building into the live `.next` tree while
  // `next start` is running replaces page chunks under that process: HTML stays
  // 200 but every page-specific script returns 400 and the browser crashes. The
  // verifier sets NEXT_DIST_DIR=.next-verify; deployments leave it unset.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  /**
   * The HTML shell must never be reused from a cache. A stale shell keeps serving an
   * old client bundle — which is exactly how a page kept reporting "Failed to fetch"
   * here even after the deployment that fixed it. Hashed assets are safe to cache
   * hard, so they keep the long lifetime.
   */
  async headers() {
    return [
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // Exclude hashed assets, which the rule above intentionally caches hard.
        source: '/((?!_next/static).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
};

module.exports = nextConfig;
