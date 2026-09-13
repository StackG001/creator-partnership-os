/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prisma and Playwright must stay external to the server bundle.
  serverExternalPackages: ['@prisma/client', 'prisma', 'playwright'],
};

export default nextConfig;
