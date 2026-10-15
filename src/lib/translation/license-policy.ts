import { z } from "zod";
import { AppError } from "../errors";

// Deployment operators must record their review of the exact configured model.
// This is an allowlist, not a declaration that all installed weights are licensed.
const approval = z.object({ model: z.string().min(1), license: z.string().min(1), evidence: z.url().refine((s) => s.startsWith("https://")), reviewedAt: z.iso.date(), commercial: z.literal(true) }).strict();
const policySchema = z.record(z.string(), approval);
export function commercialMode() { return process.env.STUDIO_COMMERCIAL_MODE === "true"; }
export function assertCommercialLicense(component: string, model: string) {
  if (!commercialMode()) return;
  let policy: z.infer<typeof policySchema>;
  try { policy = policySchema.parse(JSON.parse(process.env.STUDIO_LICENSE_APPROVALS_JSON || "{}")); }
  catch { throw new AppError("Licensregistret är ogiltigt. Kommersiell bearbetning är spärrad.", 503); }
  const entry = policy[component];
  if (!entry || entry.model !== model || /(?:non.?commercial|\bnc\b|research.only|cpml)/i.test(entry.license) || /(?:^xtts$|mms.*nc|(?:^|[-_])ryan(?:$|[-_]))/i.test(model)) throw new AppError(`Kommersiell licens är inte verifierad för ${component}. Välj en granskad modell i serverkonfigurationen.`, 422);
}
