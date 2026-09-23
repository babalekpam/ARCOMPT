import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk middleware refreshes the browser session and enables server auth().
// Authorization remains in the API's database-backed membership checks.
export default clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/api/(.*)"],
};