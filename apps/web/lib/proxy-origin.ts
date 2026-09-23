import type { NextRequest } from "next/server";

/** Browser-controlled Fetch Metadata stops same-site sibling origins from
 * submitting state-changing requests with the user's Clerk session cookie. */
export function acceptsMutationOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (!origin || site === "same-origin") return true;
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto") ?? "https";
  const allowed = [req.nextUrl.origin, process.env.APP_URL, ...(forwardedHost ? [`${forwardedProto}://${forwardedHost}`] : [])];
  return allowed.includes(origin);
}