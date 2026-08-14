export interface MerchantPrincipal {
  readonly kind: "merchant";
  readonly merchantId: string;
  readonly credentialId: string;
  readonly scopes: readonly string[];
}

export interface AdminPrincipal {
  readonly kind: "admin";
  readonly adminId: string;
  readonly sessionId: string;
  readonly tokenVersion: number;
}
