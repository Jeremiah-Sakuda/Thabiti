import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Aurora lives in us-east-1. Vercel function region pinning is configured in
  // vercel.json ("regions": ["iad1"]) so the serverless functions sit adjacent
  // to the database and cross-region latency to the writer/reader is eliminated.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
