import { clerkMiddleware } from "@clerk/nextjs/server";
import { clerkHostname, clerkPublishableKey, clerkProxyUrl } from "./lib/clerk-hosting";

// Clerk middleware refreshes the browser session and enables server auth().
// Authorization remains in the API's database-backed membership checks.
export default clerkMiddleware(() => {}, (request) => ({
  publishableKey: clerkPublishableKey(clerkHostname(request.headers), process.env),
  proxyUrl: clerkProxyUrl(process.env),
}));

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/api/(.*)"],
};