export interface AuditResult {
  handle: string;
  auditId: string;
  opportunityScore: number;
  productAngles: Array<{ title: string; promise: string; confidence: number }>;
  artifactPath: string;
}

/**
 * Reads a creator's recent content and comments, then writes an Audit row plus
 * outputs/<handle>/audit/audit.md. Sets creator status to AUDITED.
 */
export async function auditCreator(_handle: string, _postCount = 30): Promise<AuditResult> {
  throw new Error('audit: not implemented yet');
}
