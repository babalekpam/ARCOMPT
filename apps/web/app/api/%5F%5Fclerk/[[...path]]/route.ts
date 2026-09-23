import { createFrontendApiProxyHandlers } from "@clerk/nextjs/server";

// Keep this route in an escaped segment: Next treats a literal __clerk folder
// as private and omits it from the production route manifest.
export const { GET, POST, PUT, DELETE, PATCH } =
  createFrontendApiProxyHandlers({ proxyPath: "/api/__clerk" });