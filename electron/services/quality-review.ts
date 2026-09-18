export function qualityReviewPassed(report: string | undefined): boolean {
  const firstLine = report?.trim().split(/\r?\n/)[0].replace(/^[#>*\s]+/, "").replace(/\*+$/, "") ?? "";
  return /^PASS\b/i.test(firstLine);
}
