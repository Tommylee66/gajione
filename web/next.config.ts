import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pinned explicitly: the mockups at the repo root have their own
  // package.json, and without this Next infers that as the workspace root.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;
