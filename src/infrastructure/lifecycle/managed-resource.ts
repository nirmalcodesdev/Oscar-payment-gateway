export interface ManagedResource {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): Promise<boolean>;
}
