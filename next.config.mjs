import { fileURLToPath } from "url";
import { dirname } from "path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: projectRoot,
  allowedDevOrigins: [
    "localhost",
    "*.localhost",
    "127.0.0.1",
    "::1",
    "*.trycloudflare.com",
    "*.brain-md.dev",
    "*.local",
    "*.test",
    "*.internal",
    "mcp.brain-md.dev",
  ],
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
