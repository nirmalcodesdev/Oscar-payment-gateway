import type { Query, Schema, SchemaTypeOptions } from "mongoose";

import {
  isBaseUnitString,
  isPositiveBaseUnitString,
} from "../../domain/money/base-unit.js";

export const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
export const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
export const normalizedEvmAddressPattern = /^0x[0-9a-f]{40}$/;
export const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/;
export const blockHashPattern = /^0x[0-9a-fA-F]{64}$/;
export const sha256Pattern = /^[0-9a-f]{64}$/;
export const publicExtendedKeyPattern =
  /^(xpub|tpub|ypub|upub|zpub|vpub)[1-9A-HJ-NP-Za-km-z]{32,}$/;

export const strictSchemaOptions = {
  strict: "throw" as const,
  strictQuery: "throw" as const,
  minimize: false,
  versionKey: false as const,
};

export const requiredIdentifier = {
  type: String,
  required: true,
  trim: true,
  match: identifierPattern,
  maxlength: 128,
} satisfies SchemaTypeOptions<string>;

export const requiredPositiveAmount = {
  type: String,
  cast: false,
  required: true,
  validate: {
    validator: isPositiveBaseUnitString,
    message: "Amount must be a positive canonical base-unit integer string",
  },
} satisfies SchemaTypeOptions<string>;

export const optionalNonNegativeAmount = {
  type: String,
  cast: false,
  required: false,
  validate: {
    validator: isBaseUnitString,
    message: "Amount must be a canonical non-negative base-unit integer string",
  },
} satisfies SchemaTypeOptions<string>;

export const requiredNonNegativeAmount = {
  ...optionalNonNegativeAmount,
  required: true,
} satisfies SchemaTypeOptions<string>;

type ImmutableStringOptions = Omit<
  SchemaTypeOptions<string>,
  "type" | "required" | "immutable"
>;

export function immutableString(options: ImmutableStringOptions = {}) {
  return {
    ...options,
    type: String,
    required: true as const,
    immutable: true as const,
  };
}

export function rejectMutations(schema: Schema, label: string): void {
  const reject = (): never => {
    throw new Error(`${label} records are append-only`);
  };

  schema.pre("save", function () {
    if (!this.isNew) reject();
  });
  schema.pre("updateOne", reject);
  schema.pre("updateMany", reject);
  schema.pre("findOneAndUpdate", reject);
  schema.pre("replaceOne", reject);
  schema.pre("findOneAndReplace", reject);
  schema.pre("deleteOne", reject);
  schema.pre("deleteMany", reject);
  schema.pre("findOneAndDelete", reject);
}

export function rejectDeletes(schema: Schema, label: string): void {
  const reject = (): never => {
    throw new Error(`${label} records cannot be deleted`);
  };
  schema.pre("deleteOne", reject);
  schema.pre("deleteMany", reject);
  schema.pre("findOneAndDelete", reject);
}

function readRecordValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

export function requireVersionedUpdates(schema: Schema): void {
  const requireIncrement = function (this: Query<unknown, unknown>): void {
    const update = this.getUpdate();
    if (Array.isArray(update)) {
      throw new Error("Payment updates require an atomic operator document");
    }
    const increment = readRecordValue(update, "$inc");
    if (readRecordValue(increment, "version") !== 1) {
      throw new Error("Payment updates must increment version exactly once");
    }
    const filter = this.getFilter();
    if (typeof readRecordValue(filter, "version") !== "number") {
      throw new Error("Payment updates must condition on the previously read version");
    }
  };

  schema.pre("updateOne", requireIncrement);
  schema.pre("updateMany", requireIncrement);
  schema.pre("findOneAndUpdate", requireIncrement);
  schema.pre("replaceOne", function () {
    throw new Error("Payment replacement writes are forbidden");
  });
  schema.pre("findOneAndReplace", function () {
    throw new Error("Payment replacement writes are forbidden");
  });
  schema.pre("save", function () {
    if (!this.isNew) {
      throw new Error("Existing payments require a conditional atomic update");
    }
  });
}
