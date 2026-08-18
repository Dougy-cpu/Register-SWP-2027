export function buildStripeCustomerDisplayName(
  contactName: string,
  contactCompany?: string | null,
): string {
  const name = contactName.trim();
  const company = contactCompany?.trim();

  if (!company) return name;
  if (!name || name.toLowerCase() === company.toLowerCase()) return company;

  return `${company}, ${name}`;
}
