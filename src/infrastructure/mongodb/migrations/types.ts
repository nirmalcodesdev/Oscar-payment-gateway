import type { Db } from "mongodb";

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  apply(db: Db): Promise<void>;
}
