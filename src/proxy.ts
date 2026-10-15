import { NextResponse, type NextRequest } from "next/server";
import { translationDeploymentBlock } from "@/lib/translation/deployment";
export function proxy(request: NextRequest) {
  const reason = translationDeploymentBlock(request.url, request.headers.get("host"));
  if (reason) return NextResponse.json({ error: reason }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return NextResponse.next();
}
export const config = { matcher: ["/api/translation/:path*", "/translation/:path*"] };
