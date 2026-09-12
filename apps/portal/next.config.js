/** @type {import('next').NextConfig} */
const nextConfig = {
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
