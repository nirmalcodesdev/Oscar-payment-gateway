import type {
  AdminPrincipal,
  MerchantPrincipal,
} from "../../application/auth/principals.js";

declare global {
  namespace Express {
    interface Request {
      readonly merchantPrincipal?: MerchantPrincipal;
      readonly adminPrincipal?: AdminPrincipal;
    }
  }
}

export {};
